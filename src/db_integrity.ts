import fs from "node:fs";
import BetterSqlite3 from "better-sqlite3";

export type DatabaseIntegrityMode = "quick" | "integrity";

export interface DatabaseIntegritySnapshot {
  /** True when the database passed the integrity scan. */
  ok: boolean;
  /** "ok" when healthy, otherwise the reported problem. */
  result: string;
  /** Which scan produced the result. */
  mode: DatabaseIntegrityMode;
  /** ISO timestamp of the completed scan. */
  checkedAt: string;
  /** Wall time the scan took. */
  durationMs: number;
}

export interface DatabaseIntegrityResult extends DatabaseIntegritySnapshot {
  /** Number of pages in the database file. */
  pageCount: number;
  /** Size of the main database file in bytes. */
  fileBytes: number;
}

function pragmaRows(db: BetterSqlite3.Database, pragma: string): string[] {
  const rows = db.pragma(pragma) as Array<Record<string, unknown>>;
  return rows.map((row) => String(Object.values(row)[0] ?? ""));
}

/**
 * Runs `quick_check`, escalating to the full `integrity_check` only when the
 * quick pass reports a problem. Both scans read every page of the database
 * file, so they are intentionally never called from a request handler.
 *
 * `full` forces the complete `integrity_check`, which is what conservative
 * callers (backup candidates, legacy startup backup mode) need.
 */
export function runIntegrityCheck(
  db: BetterSqlite3.Database,
  options: { full?: boolean } = {},
): DatabaseIntegritySnapshot {
  const startedAt = Date.now();
  if (options.full) {
    return integritySnapshot(pragmaRows(db, "integrity_check"), "integrity", startedAt);
  }
  const quick = pragmaRows(db, "quick_check");
  if (quick.length === 1 && quick[0] === "ok") {
    return integritySnapshot(["ok"], "quick", startedAt);
  }
  return integritySnapshot(pragmaRows(db, "integrity_check"), "integrity", startedAt);
}

function integritySnapshot(
  rows: string[],
  mode: DatabaseIntegrityMode,
  startedAt: number,
): DatabaseIntegritySnapshot {
  const healthy = rows.length === 1 && rows[0] === "ok";
  return {
    ok: healthy,
    result: healthy ? "ok" : rows.join("; "),
    mode,
    checkedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
  };
}

/**
 * Checks a database file without touching the running daemon: the file is
 * opened read-only on a separate connection, so a large scan never occupies
 * the daemon's event loop.
 */
export function checkDatabaseIntegrity(dbPath: string): DatabaseIntegrityResult {
  let db: BetterSqlite3.Database;
  try {
    db = openReadOnlyDatabase(dbPath);
  } catch (error) {
    return failedIntegrityResult(dbPath, error);
  }
  try {
    const raw = runIntegrityCheck(db);
    return {
      ...raw,
      pageCount: Number(db.pragma("page_count", { simple: true })),
      fileBytes: fileSize(dbPath),
    };
  } catch (error) {
    return failedIntegrityResult(dbPath, error);
  } finally {
    db.close();
  }
}

function failedIntegrityResult(dbPath: string, error: unknown): DatabaseIntegrityResult {
  return {
    ok: false,
    result: error instanceof Error ? error.message : String(error),
    mode: "quick",
    checkedAt: new Date().toISOString(),
    durationMs: 0,
    pageCount: 0,
    fileBytes: fileSize(dbPath),
  };
}

function openReadOnlyDatabase(dbPath: string): BetterSqlite3.Database {
  try {
    return new BetterSqlite3(dbPath, { readonly: true, fileMustExist: true });
  } catch {
    // A WAL database can refuse a strictly read-only connection when the
    // shared-memory file is not accessible; fall back to a query-only
    // connection, which still cannot modify the database.
    const db = new BetterSqlite3(dbPath, { fileMustExist: true });
    db.pragma("query_only = ON");
    return db;
  }
}

function fileSize(dbPath: string): number {
  try {
    return fs.statSync(dbPath).size;
  } catch {
    return 0;
  }
}
