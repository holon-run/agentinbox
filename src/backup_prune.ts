import fs from "node:fs";
import path from "node:path";
import { isPidAlive } from "./util";

/**
 * Planning and apply support for `agentinbox backup prune`.
 *
 * The product owns exactly these local database artifacts (all derived from
 * the configured DB path, so the naming is deterministic):
 *
 * - `<db>.bak` — manual snapshot written by `agentinbox backup`. Always kept:
 *   it is the most recent operator-controlled backup.
 * - `<db>.pre-migrate-v<N>.bak` — pre-migration snapshots, automatically kept
 *   bounded by `AGENTINBOX_MIGRATION_BACKUP_KEEP` (default 5). The quota
 *   counts only snapshots that pass a read-only header validation, so an
 *   invalid or truncated snapshot never displaces a usable backup.
 * - `<db>.corrupt[.<suffix>]` — quarantined copies of a database that failed
 *   integrity checks during recovery.
 * - `<db>.malformed[.<suffix>]` — legacy quarantine naming from older
 *   versions; no current writer, kept only as a prune category.
 * - `<db>...bak.<pid>.tmp` and `<db>...bak.<pid>.tmp-journal` — staged backup
 *   temporaries and their SQLite rollback journals; orphans once the owning
 *   process is gone.
 *
 * Everything else in the directory (the live database, `-wal`/`-shm`
 * sidecars, pre-v1 archives, unrelated files) is never reported or deleted.
 */

export type BackupPruneCategory = "pre-migrate" | "corrupt" | "malformed" | "orphan-tmp";

export interface BackupPruneEntry {
  path: string;
  category: BackupPruneCategory;
  bytes: number;
  action: "delete" | "keep";
  reason?: string;
}

export interface BackupPrunePlan {
  dbPath: string;
  keep: number;
  reclaimableBytes: number;
  entries: BackupPruneEntry[];
}

export interface BackupPruneResult {
  deleted: Array<{ path: string; bytes: number }>;
  failed: Array<{ path: string; error: string }>;
  deletedBytes: number;
}

export interface OrphanBackupTmp {
  path: string;
  pid: number;
  bytes: number;
  live: boolean;
}

/** Matches DEFAULT_MIGRATION_BACKUP_KEEP in store.ts. */
const DEFAULT_BACKUP_PRUNE_KEEP = 5;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function fileSize(filePath: string): number {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

const SQLITE_HEADER_MAGIC = "SQLite format 3\u0000";
const SQLITE_HEADER_BYTES = 100;

/**
 * Best-effort read-only check that a candidate snapshot is a complete SQLite
 * database file: valid magic, a sane page size, and a page count consistent
 * with the file size. Deliberately conservative — when the header cannot be
 * read the snapshot is reported usable, so it still consumes retention quota
 * and is never deleted merely because validation itself failed.
 */
function isUsableSqliteSnapshot(filePath: string): boolean {
  let handle: number;
  try {
    handle = fs.openSync(filePath, "r");
  } catch {
    return true;
  }
  const header = Buffer.alloc(SQLITE_HEADER_BYTES);
  try {
    const bytesRead = fs.readSync(handle, header, 0, SQLITE_HEADER_BYTES, 0);
    const { size } = fs.fstatSync(handle);
    if (bytesRead < SQLITE_HEADER_BYTES || size < SQLITE_HEADER_BYTES) {
      return false;
    }
    if (header.subarray(0, 16).toString("latin1") !== SQLITE_HEADER_MAGIC) {
      return false;
    }
    const pageSize = header.readUInt16BE(16);
    const effectivePageSize = pageSize === 1 ? 65536 : pageSize;
    const sanePageSize =
      effectivePageSize >= 512 &&
      effectivePageSize <= 65536 &&
      (effectivePageSize & (effectivePageSize - 1)) === 0;
    if (!sanePageSize) {
      return false;
    }
    const pageCount = header.readUInt32BE(28);
    return pageCount === 0 || size >= pageCount * effectivePageSize;
  } catch {
    return true;
  } finally {
    fs.closeSync(handle);
  }
}

/**
 * Lists leftover `<db>.*.bak.<pid>.tmp` / `.tmp-journal` files (manual and
 * pre-migration backup temporaries plus their SQLite rollback journals).
 * Files owned by a live pid belong to a concurrent backup and are reported
 * with `live: true` so callers can preserve them.
 */
export function listOrphanBackupTmpFiles(
  dbPath: string,
  pidAlive: (pid: number) => boolean = isPidAlive,
): OrphanBackupTmp[] {
  const dir = path.dirname(dbPath);
  const pattern = new RegExp(
    `^${escapeRegExp(path.basename(dbPath))}\\.(?:.+\\.)?bak\\.(\\d+)\\.tmp(?:-journal)?$`,
  );
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const orphans: OrphanBackupTmp[] = [];
  for (const name of entries) {
    const match = pattern.exec(name);
    if (!match) {
      continue;
    }
    const pid = Number.parseInt(match[1]!, 10);
    if (!Number.isInteger(pid) || pid <= 0) {
      continue;
    }
    const candidatePath = path.join(dir, name);
    orphans.push({ path: candidatePath, pid, bytes: fileSize(candidatePath), live: pidAlive(pid) });
  }
  orphans.sort((left, right) => left.path.localeCompare(right.path));
  return orphans;
}

/**
 * Builds a prune plan for the directory of `dbPath`. The plan is pure: no
 * files are touched. `keep` defaults to the `AGENTINBOX_MIGRATION_BACKUP_KEEP`
 * environment value (default 5), matching automatic migration-backup pruning;
 * values <= 0 disable deletion of pre-migration snapshots entirely.
 * The quota counts only snapshots whose header passes the read-only
 * usability check, so the newest usable snapshot is always retained and an
 * invalid snapshot never displaces a usable backup.
 */
export function planBackupPrune(
  dbPath: string,
  options: { keep?: number; env?: NodeJS.ProcessEnv } = {},
): BackupPrunePlan {
  const keep = options.keep ?? backupPruneKeep(options.env);
  const dir = path.dirname(dbPath);
  const base = escapeRegExp(path.basename(dbPath));
  const preMigrationPattern = new RegExp(`^${base}\\.pre-migrate-v(\\d+)\\.bak$`);
  const corruptPattern = new RegExp(`^${base}\\.corrupt(?:\\..+)?$`);
  const malformedPattern = new RegExp(`^${base}\\.malformed(?:\\..+)?$`);
  const entries: BackupPruneEntry[] = [];
  const preMigrationFiles: Array<{ path: string; version: number; usable: boolean }> = [];
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    names = [];
  }
  for (const name of names) {
    const candidatePath = path.join(dir, name);
    const preMigration = preMigrationPattern.exec(name);
    if (preMigration) {
      preMigrationFiles.push({
        path: candidatePath,
        version: Number.parseInt(preMigration[1]!, 10),
        usable: isUsableSqliteSnapshot(candidatePath),
      });
      continue;
    }
    const category = corruptPattern.test(name)
      ? "corrupt"
      : malformedPattern.test(name)
        ? "malformed"
        : null;
    if (category) {
      entries.push({ path: candidatePath, category, bytes: fileSize(candidatePath), action: "delete" });
    }
  }
  preMigrationFiles.sort((left, right) => right.version - left.version);
  // Retention counts only usable snapshots: the newest usable snapshot is
  // always within quota, and an invalid snapshot never displaces a usable
  // backup by consuming one of the retained slots.
  const usablePaths = new Set(
    keep > 0
      ? preMigrationFiles
          .filter((file) => file.usable)
          .slice(0, keep)
          .map((file) => file.path)
      : [],
  );
  for (const file of preMigrationFiles) {
    const retained = keep <= 0 || usablePaths.has(file.path);
    entries.push({
      path: file.path,
      category: "pre-migrate",
      bytes: fileSize(file.path),
      action: retained ? "keep" : "delete",
      reason: retained
        ? keep <= 0
          ? "keep policy disabled (keep <= 0)"
          : `within keep policy (keep ${keep})`
        : file.usable
          ? `beyond keep policy (keep ${keep})`
          : "not a usable SQLite snapshot",
    });
  }
  for (const orphan of listOrphanBackupTmpFiles(dbPath)) {
    entries.push({
      path: orphan.path,
      category: "orphan-tmp",
      bytes: orphan.bytes,
      action: orphan.live ? "keep" : "delete",
      reason: orphan.live ? `owned by live pid ${orphan.pid}` : undefined,
    });
  }
  const deletable = entries.filter((entry) => entry.action === "delete");
  return {
    dbPath,
    keep,
    reclaimableBytes: deletable.reduce((total, entry) => total + entry.bytes, 0),
    entries,
  };
}

/**
 * Strictly parses a keep value: only a complete decimal integer is accepted.
 * `Number.parseInt` alone silently truncates `1.5` to 1 and `1e2` to 1, which
 * with `--apply` would delete more backups than the operator requested. The
 * CLI rejects an invalid `--keep` flag outright; an invalid environment value
 * falls back to the default, matching migration-time pruning.
 */
export function parseBackupPruneKeep(value: string): number | undefined {
  if (!/^\d+$/.test(value)) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function backupPruneKeep(env: NodeJS.ProcessEnv | undefined): number {
  return parseBackupPruneKeep(env?.AGENTINBOX_MIGRATION_BACKUP_KEEP ?? "") ?? DEFAULT_BACKUP_PRUNE_KEEP;
}

/**
 * Deletes exactly the plan's `delete` entries. Never touches retained or
 * unrecognized files. Deletion failures are reported per file instead of
 * aborting the batch.
 */
export function applyBackupPrune(plan: BackupPrunePlan): BackupPruneResult {
  const deleted: Array<{ path: string; bytes: number }> = [];
  const failed: Array<{ path: string; error: string }> = [];
  for (const entry of plan.entries) {
    if (entry.action !== "delete") {
      continue;
    }
    try {
      fs.rmSync(entry.path, { force: true });
      deleted.push({ path: entry.path, bytes: entry.bytes });
    } catch (error) {
      failed.push({ path: entry.path, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return {
    deleted,
    failed,
    deletedBytes: deleted.reduce((total, file) => total + file.bytes, 0),
  };
}
