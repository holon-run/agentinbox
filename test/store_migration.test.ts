import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import BetterSqlite3 from "better-sqlite3";
import { AgentInboxStore } from "../src/store";

async function createLegacyDb(dbPath: string): Promise<void> {
  fs.rmSync(dbPath, { force: true });
  const db = new BetterSqlite3(dbPath);
  db.exec(`
    create table if not exists sources (
      source_id text primary key,
      source_type text not null,
      source_key text not null,
      config_ref text,
      config_json text not null,
      status text not null,
      checkpoint text,
      created_at text not null,
      updated_at text not null,
      unique(source_type, source_key)
    );

    create table if not exists agents (
      agent_id text primary key,
      status text not null,
      offline_since text,
      runtime_kind text not null,
      runtime_session_id text,
      created_at text not null,
      updated_at text not null,
      last_seen_at text not null
    );

    create table if not exists inboxes (
      inbox_id text primary key,
      owner_agent_id text not null unique,
      created_at text not null
    );

    create table if not exists subscriptions (
      subscription_id text primary key,
      agent_id text not null,
      source_id text not null,
      filter_json text not null,
      lifecycle_mode text not null,
      expires_at text,
      start_policy text not null,
      start_offset integer,
      start_time text,
      created_at text not null
    );

    create table if not exists activation_targets (
      target_id text primary key,
      agent_id text not null,
      kind text not null,
      status text not null,
      offline_since text,
      consecutive_failures integer not null,
      last_delivered_at text,
      last_error text,
      mode text not null,
      notify_lease_ms integer not null,
      url text,
      runtime_kind text,
      runtime_session_id text,
      backend text,
      tmux_pane_id text,
      tty text,
      term_program text,
      iterm_session_id text,
      created_at text not null,
      updated_at text not null,
      last_seen_at text not null
    );
  `);
  db.exec("pragma user_version = 12;");
  db.close();
}

async function createV1BaselineDbWithSourceScopedLifecycleRetirement(dbPath: string): Promise<void> {
  const db = new BetterSqlite3(dbPath);
  const baselineSql = fs.readFileSync(path.resolve(__dirname, "../drizzle/migrations/0000_v1_initial.sql"), "utf8");
  db.exec(`
    create table if not exists __drizzle_migrations (
      id integer primary key autoincrement,
      tag text not null unique,
      applied_at text not null
    );
  `);
  db.exec(baselineSql);
  db.exec(`
    insert into __drizzle_migrations (tag, applied_at) values ('0000_v1_initial', '2026-04-19T00:00:00.000Z');
    insert into source_hosts (host_id, host_type, host_key, config_ref, config_json, status, created_at, updated_at)
    values ('hst_legacy_github', 'github', 'uxcAuth:default', null, '{}', 'active', '2026-04-19T00:00:00.000Z', '2026-04-19T00:00:00.000Z');
    insert into sources (
      source_id, host_id, stream_kind, stream_key, source_type, source_key, config_ref, config_json, status, checkpoint, created_at, updated_at
    ) values (
      'src_legacy_github', 'hst_legacy_github', 'repo_events', 'holon-run/agentinbox', 'github_repo', 'holon-run/agentinbox', null, '{}', 'active', null,
      '2026-04-19T00:00:00.000Z', '2026-04-19T00:00:00.000Z'
    );
    insert into subscription_lifecycle_retirements (
      subscription_id, source_id, tracked_resource_ref, retire_at, terminal_state, terminal_result, terminal_occurred_at, created_at, updated_at
    ) values (
      'sub_legacy_retirement', 'src_legacy_github', 'repo:holon-run/agentinbox:pr:72', '2026-04-19T01:00:00.000Z', 'closed', 'merged',
      '2026-04-19T00:30:00.000Z', '2026-04-19T00:30:00.000Z', '2026-04-19T00:30:00.000Z'
    );
  `);
  db.close();
}

async function readMigrationState(dbPath: string): Promise<{
  appliedTags: string[];
  hasNewIndex: boolean;
  retirementColumns: string[];
  hasTrackedResourceIndex: boolean;
}> {
  const db = new BetterSqlite3(dbPath, { readonly: true, fileMustExist: true });
  const appliedTags = db.prepare("select tag from __drizzle_migrations order by id asc;")
    .all()
    .map((row) => String((row as Record<string, unknown>).tag));
  const hasNewIndex = db.prepare("pragma index_list('inbox_items');")
    .all()
    .some((row) => String((row as Record<string, unknown>).name) === "idx_inbox_items_source_occurred_at");
  const hasTrackedResourceIndex = db.prepare("pragma index_list('subscriptions');")
    .all()
    .some((row) => String((row as Record<string, unknown>).name) === "idx_subscriptions_tracked_resource_source");
  const retirementColumns = db.prepare("pragma table_info('subscription_lifecycle_retirements');")
    .all()
    .map((row) => String((row as Record<string, unknown>).name));
  db.close();
  return { appliedTags, hasNewIndex, retirementColumns, hasTrackedResourceIndex };
}

test("store migrates a new database using drizzle SQL migrations", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentinbox-migrate-new-"));
  const dbPath = path.join(dir, "agentinbox.sqlite");
  const store = await AgentInboxStore.open(dbPath);
  try {
    const state = await readMigrationState(dbPath);
    assert.deepEqual(state.appliedTags, [
      "0000_v1_initial",
      "0001_activation_entry_boundary",
      "0002_host_scoped_lifecycle_retirements",
      "0003_subscription_tracked_resource_indexes",
      "0004_provider_raw_payload",
    ]);
    assert.equal(state.hasNewIndex, true);
    assert.deepEqual(state.retirementColumns.includes("host_id"), true);
    assert.equal(state.hasTrackedResourceIndex, true);
    const backups = fs.readdirSync(dir).filter((name) => name.includes(".pre-v1."));
    assert.equal(backups.length, 0);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("store opens databases with WAL journaling and foreign keys enabled", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentinbox-db-health-"));
  const dbPath = path.join(dir, "agentinbox.sqlite");
  const store = await AgentInboxStore.open(dbPath);
  try {
    const health = store.getDatabaseHealth();
    assert.equal(health.integrityCheck, "ok");
    assert.equal(health.journalMode, "wal");
    assert.equal(health.foreignKeys, true);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("store reopens an existing v1 database without archiving it", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentinbox-migrate-reopen-v1-"));
  const dbPath = path.join(dir, "agentinbox.sqlite");
  const first = await AgentInboxStore.open(dbPath);
  first.close();

  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map((arg) => String(arg)).join(" "));
  };
  const reopened = await AgentInboxStore.open(dbPath);
  try {
    const state = await readMigrationState(dbPath);
    assert.deepEqual(state.appliedTags, [
      "0000_v1_initial",
      "0001_activation_entry_boundary",
      "0002_host_scoped_lifecycle_retirements",
      "0003_subscription_tracked_resource_indexes",
      "0004_provider_raw_payload",
    ]);
    assert.equal(warnings.length, 0);
    assert.equal(state.hasTrackedResourceIndex, true);
    const backups = fs.readdirSync(dir).filter((name) => name.includes(".pre-v1."));
    assert.equal(backups.length, 0);
  } finally {
    console.warn = originalWarn;
    reopened.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("store recovers a corrupt main database from the latest healthy backup", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentinbox-recover-backup-"));
  const dbPath = path.join(dir, "agentinbox.sqlite");
  let recovered: AgentInboxStore | null = null;
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map((arg) => String(arg)).join(" "));
  };
  try {
    const first = await AgentInboxStore.open(dbPath);
    first.close();

    const reopened = await AgentInboxStore.open(dbPath);
    reopened.close();
    assert.equal(fs.existsSync(`${dbPath}.bak`), true);

    fs.rmSync(`${dbPath}-wal`, { force: true });
    fs.rmSync(`${dbPath}-shm`, { force: true });
    fs.writeFileSync(dbPath, "not a sqlite database");

    recovered = await AgentInboxStore.open(dbPath);
    const state = await readMigrationState(dbPath);
    assert.deepEqual(state.appliedTags, [
      "0000_v1_initial",
      "0001_activation_entry_boundary",
      "0002_host_scoped_lifecycle_retirements",
      "0003_subscription_tracked_resource_indexes",
      "0004_provider_raw_payload",
    ]);
    assert.equal(recovered.getDatabaseHealth().integrityCheck, "ok");
    assert.match(warnings.join("\n"), /recovered local database from/);
    assert.equal(fs.readdirSync(dir).some((name) => name.startsWith("agentinbox.sqlite.corrupt")), true);
  } finally {
    console.warn = originalWarn;
    recovered?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("store archives a pre-v1 database and starts fresh with the v1 baseline", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentinbox-migrate-legacy-"));
  const dbPath = path.join(dir, "agentinbox.sqlite");
  await createLegacyDb(dbPath);
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map((arg) => String(arg)).join(" "));
  };
  const store = await AgentInboxStore.open(dbPath);
  try {
    const state = await readMigrationState(dbPath);
    assert.deepEqual(state.appliedTags, [
      "0000_v1_initial",
      "0001_activation_entry_boundary",
      "0002_host_scoped_lifecycle_retirements",
      "0003_subscription_tracked_resource_indexes",
      "0004_provider_raw_payload",
    ]);
    assert.equal(state.hasNewIndex, true);
    assert.equal(state.hasTrackedResourceIndex, true);
    const backups = fs.readdirSync(dir).filter((name) => name.includes(".pre-v1."));
    assert.equal(backups.length, 1);
    assert.match(backups[0]!, /^agentinbox\.sqlite\.pre-v1\..+\.bak(?:\.\d+)?$/);
    assert.match(warnings[0] ?? "", /archived pre-v1 local database/);
    assert.match(warnings[0] ?? "", /no data imported/);
  } finally {
    console.warn = originalWarn;
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("store upgrades source-scoped lifecycle retirements to host-scoped retirements for existing v1 databases", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentinbox-migrate-lifecycle-host-"));
  const dbPath = path.join(dir, "agentinbox.sqlite");
  await createV1BaselineDbWithSourceScopedLifecycleRetirement(dbPath);
  const store = await AgentInboxStore.open(dbPath);
  try {
    const state = await readMigrationState(dbPath);
    assert.deepEqual(state.appliedTags, [
      "0000_v1_initial",
      "0001_activation_entry_boundary",
      "0002_host_scoped_lifecycle_retirements",
      "0003_subscription_tracked_resource_indexes",
      "0004_provider_raw_payload",
    ]);
    assert.deepEqual(state.retirementColumns.includes("host_id"), true);
    assert.deepEqual(state.retirementColumns.includes("source_id"), false);
    assert.equal(state.hasTrackedResourceIndex, true);
    const retirement = store.getSubscriptionLifecycleRetirement("sub_legacy_retirement");
    assert.equal(retirement?.hostId, "hst_legacy_github");
    assert.equal(retirement?.trackedResourceRef, "repo:holon-run/agentinbox:pr:72");
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("store archives repeated pre-v1 databases without clobbering earlier backups", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentinbox-migrate-legacy-repeat-"));
  const dbPath = path.join(dir, "agentinbox.sqlite");
  await createLegacyDb(dbPath);
  try {
    const first = await AgentInboxStore.open(dbPath);
    first.close();

    await createLegacyDb(dbPath);
    const second = await AgentInboxStore.open(dbPath);
    second.close();

    const backups = fs.readdirSync(dir)
      .filter((name) => name.includes(".pre-v1."))
      .sort();
    assert.equal(backups.length, 2);
    assert.notEqual(backups[0], backups[1]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
