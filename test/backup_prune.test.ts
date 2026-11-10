import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { AgentInboxStore } from "../src/store";
import { applyBackupPrune, listOrphanBackupTmpFiles, planBackupPrune } from "../src/backup_prune";

/** No Linux process owns this pid, so isPidAlive() reports it as dead. */
const DEAD_PID = 2147483647;

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agentinbox-backup-prune-"));
}

function write(filePath: string, bytes = 16): string {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, Buffer.alloc(bytes, 1));
  return filePath;
}

function seedArtifacts(dbPath: string): void {
  // Protected artifacts: never listed by a prune plan.
  write(dbPath, 2048);
  write(`${dbPath}.bak`, 1024);
  write(`${dbPath}-wal`, 512);
  write(`${dbPath}-shm`, 32);
  write(`${dbPath}.pre-v1.2026-01-01T00-00-00Z.bak`, 256);
  write(path.join(path.dirname(dbPath), "unrelated.txt"), 8);
  // Pre-migration snapshots v1..v7.
  for (let version = 1; version <= 7; version += 1) {
    write(`${dbPath}.pre-migrate-v${version}.bak`, 100 + version);
  }
  // Corrupt / malformed quarantines (current and legacy naming).
  write(`${dbPath}.corrupt`, 4096);
  write(`${dbPath}.corrupt.20260612T184804`, 2048);
  write(`${dbPath}.malformed.20260612T103552Z`, 512);
  // Backup temporaries with dead owners (including -journal sidecars).
  write(`${dbPath}.bak.${DEAD_PID}.tmp`, 64);
  write(`${dbPath}.bak.${DEAD_PID}.tmp-journal`, 1024);
  write(`${dbPath}.pre-migrate-v3.bak.${DEAD_PID}.tmp-journal`, 1024);
  // A temporary owned by this live process must be preserved.
  write(`${dbPath}.bak.${process.pid}.tmp`, 64);
}

test("planBackupPrune categorizes artifacts and bounds pre-migration retention", () => {
  const dir = tempDir();
  try {
    const dbPath = path.join(dir, "test.sqlite");
    seedArtifacts(dbPath);
    const plan = planBackupPrune(dbPath, { env: {} });
    assert.equal(plan.keep, 5);
    const byPath = new Map(plan.entries.map((entry) => [entry.path, entry]));
    // Newest 5 pre-migration snapshots (v7..v3) kept; v2/v1 beyond policy.
    for (let version = 1; version <= 7; version += 1) {
      const entry = byPath.get(`${dbPath}.pre-migrate-v${version}.bak`);
      assert.ok(entry, `missing entry for v${version}`);
      assert.equal(entry.category, "pre-migrate");
      assert.equal(entry.action, version >= 3 ? "keep" : "delete");
    }
    // Quarantines are always deletable.
    assert.equal(byPath.get(`${dbPath}.corrupt`)?.action, "delete");
    assert.equal(byPath.get(`${dbPath}.corrupt.20260612T184804`)?.action, "delete");
    assert.equal(byPath.get(`${dbPath}.malformed.20260612T103552Z`)?.action, "delete");
    // Dead-owner temporaries (including -journal) deletable; live owner kept.
    assert.equal(byPath.get(`${dbPath}.bak.${DEAD_PID}.tmp`)?.action, "delete");
    assert.equal(byPath.get(`${dbPath}.bak.${DEAD_PID}.tmp-journal`)?.action, "delete");
    assert.equal(byPath.get(`${dbPath}.pre-migrate-v3.bak.${DEAD_PID}.tmp-journal`)?.action, "delete");
    const live = byPath.get(`${dbPath}.bak.${process.pid}.tmp`);
    assert.equal(live?.action, "keep");
    assert.match(live?.reason ?? "", /live pid/);
    // Protected artifacts are never listed.
    const protectedPaths = [
      dbPath,
      `${dbPath}.bak`,
      `${dbPath}-wal`,
      `${dbPath}-shm`,
      `${dbPath}.pre-v1.2026-01-01T00-00-00Z.bak`,
      path.join(dir, "unrelated.txt"),
    ];
    for (const protectedPath of protectedPaths) {
      assert.equal(byPath.has(protectedPath), false);
    }
    const deletableBytes = plan.entries
      .filter((entry) => entry.action === "delete")
      .reduce((total, entry) => total + entry.bytes, 0);
    assert.equal(plan.reclaimableBytes, deletableBytes);
    assert.ok(plan.reclaimableBytes > 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("planBackupPrune keep policy: flag beats env beats default; 0 keeps all", () => {
  const dir = tempDir();
  try {
    const dbPath = path.join(dir, "test.sqlite");
    for (let version = 1; version <= 4; version += 1) {
      write(`${dbPath}.pre-migrate-v${version}.bak`, 10);
    }
    assert.equal(planBackupPrune(dbPath, { env: {} }).keep, 5);
    assert.equal(
      planBackupPrune(dbPath, { env: { AGENTINBOX_MIGRATION_BACKUP_KEEP: "1" } }).keep,
      1,
    );
    const flag = planBackupPrune(dbPath, { keep: 2, env: { AGENTINBOX_MIGRATION_BACKUP_KEEP: "1" } });
    assert.equal(flag.keep, 2);
    assert.equal(flag.entries.filter((entry) => entry.action === "delete").length, 2);
    const disabled = planBackupPrune(dbPath, { keep: 0 });
    assert.equal(disabled.entries.filter((entry) => entry.action === "delete").length, 0);
    const keepOne = planBackupPrune(dbPath, { keep: 1 });
    assert.equal(keepOne.entries.filter((entry) => entry.action === "delete").length, 3);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("applyBackupPrune deletes exactly the planned deletions", () => {
  const dir = tempDir();
  try {
    const dbPath = path.join(dir, "test.sqlite");
    seedArtifacts(dbPath);
    const plan = planBackupPrune(dbPath, { env: {} });
    const result = applyBackupPrune(plan);
    assert.deepEqual(result.failed, []);
    assert.equal(result.deleted.length, plan.entries.filter((entry) => entry.action === "delete").length);
    assert.equal(result.deletedBytes, plan.reclaimableBytes);
    for (const entry of plan.entries) {
      assert.equal(fs.existsSync(entry.path), entry.action === "keep");
    }
    for (const protectedPath of [
      dbPath,
      `${dbPath}.bak`,
      `${dbPath}-wal`,
      `${dbPath}-shm`,
      `${dbPath}.pre-v1.2026-01-01T00-00-00Z.bak`,
      path.join(dir, "unrelated.txt"),
    ]) {
      assert.equal(fs.existsSync(protectedPath), true);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("planBackupPrune on a missing directory returns an empty plan", () => {
  const plan = planBackupPrune(path.join(os.tmpdir(), "agentinbox-missing-dir-xyz", "test.sqlite"), { env: {} });
  assert.deepEqual(plan.entries, []);
  assert.equal(plan.reclaimableBytes, 0);
});

test("listOrphanBackupTmpFiles classifies live versus dead owners", () => {
  const dir = tempDir();
  try {
    const dbPath = path.join(dir, "test.sqlite");
    write(dbPath, 32);
    write(`${dbPath}.bak.${DEAD_PID}.tmp-journal`, 1024);
    write(`${dbPath}.bak.${process.pid}.tmp`, 64);
    const orphans = listOrphanBackupTmpFiles(dbPath);
    assert.equal(orphans.length, 2);
    const dead = orphans.find((orphan) => orphan.path.endsWith(`${DEAD_PID}.tmp-journal`));
    const live = orphans.find((orphan) => orphan.pid === process.pid);
    assert.equal(dead?.live, false);
    assert.equal(dead?.bytes, 1024);
    assert.equal(live?.live, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("store open removes dead-owner .tmp-journal leftovers (regression)", async () => {
  const dir = tempDir();
  const journal = write(path.join(dir, "test.sqlite.bak.2147483647.tmp-journal"), 1024);
  const tmp = write(path.join(dir, "test.sqlite.bak.2147483647.tmp"), 64);
  const store = await AgentInboxStore.open(path.join(dir, "test.sqlite"), { env: {} });
  try {
    assert.equal(fs.existsSync(journal), false);
    assert.equal(fs.existsSync(tmp), false);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
