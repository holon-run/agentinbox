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
 *   bounded by `AGENTINBOX_MIGRATION_BACKUP_KEEP` (default 5).
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
  const preMigrationFiles: Array<{ path: string; version: number }> = [];
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
  const keepReason =
    keep <= 0 ? "keep policy disabled (keep <= 0)" : `within keep policy (keep ${keep})`;
  preMigrationFiles.forEach((file, index) => {
    const deleteFile = keep > 0 && index >= keep;
    entries.push({
      path: file.path,
      category: "pre-migrate",
      bytes: fileSize(file.path),
      action: deleteFile ? "delete" : "keep",
      reason: deleteFile ? `beyond keep policy (keep ${keep})` : keepReason,
    });
  });
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

function backupPruneKeep(env: NodeJS.ProcessEnv | undefined): number {
  const parsed = Number.parseInt(env?.AGENTINBOX_MIGRATION_BACKUP_KEEP ?? "", 10);
  return Number.isInteger(parsed) ? parsed : DEFAULT_BACKUP_PRUNE_KEEP;
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
