import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { spawn, spawnSync } from "node:child_process";
import {
  acquireDaemonLock,
  autostartDisabled,
  daemonStatus,
  readDaemonLock,
  releaseDaemonLock,
  removePidFileIfOwned,
  resolveStartTimeoutMs,
} from "../src/daemon";
import { daemonLockPath } from "../src/paths";
import { AgentInboxStore } from "../src/store";

const REPO_DIR = path.resolve(__dirname, "..");

function runCli(args: string[], env: NodeJS.ProcessEnv, timeoutMs = 60_000) {
  return spawnSync("node", ["-r", "ts-node/register", "src/cli.ts", ...args], {
    cwd: REPO_DIR,
    env,
    encoding: "utf8",
    timeout: timeoutMs,
  });
}

function tempHome(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(predicate: () => Promise<boolean> | boolean, timeoutMs: number): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) {
      return true;
    }
    await sleep(150);
  }
  return false;
}

function waitExit(child: { on: (event: string, listener: () => void) => void }, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.on("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

test("acquireDaemonLock is exclusive per process and releases only for the owner", () => {
  const home = tempHome("agentinbox-lock-unit-home-");
  try {
    const lockPath = daemonLockPath(path.join(home, "agentinbox.sock"));
    const first = acquireDaemonLock(lockPath);
    assert.equal(first.acquired, true);

    const second = acquireDaemonLock(lockPath);
    assert.equal(second.acquired, false);
    assert.equal(second.holder?.pid, process.pid);

    // Release with a foreign pid must not free the lock.
    releaseDaemonLock(lockPath, 999_999);
    assert.equal(readDaemonLock(lockPath)?.pid, process.pid);

    releaseDaemonLock(lockPath, process.pid);
    assert.equal(readDaemonLock(lockPath), null);

    const third = acquireDaemonLock(lockPath);
    assert.equal(third.acquired, true);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("acquireDaemonLock removes stale locks from dead pids", () => {
  const home = tempHome("agentinbox-lock-stale-home-");
  try {
    const lockPath = daemonLockPath(path.join(home, "agentinbox.sock"));
    fs.writeFileSync(
      lockPath,
      JSON.stringify({ pid: 999_999, processStartedAt: null, acquiredAt: new Date().toISOString() }),
    );
    const acquisition = acquireDaemonLock(lockPath);
    assert.equal(acquisition.acquired, true);
    assert.equal(readDaemonLock(lockPath)?.pid, process.pid);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("resolveStartTimeoutMs defaults to 60s and honors AGENTINBOX_START_TIMEOUT_MS", () => {
  assert.equal(resolveStartTimeoutMs({}), 60_000);
  assert.equal(resolveStartTimeoutMs({ AGENTINBOX_START_TIMEOUT_MS: "" }), 60_000);
  assert.equal(resolveStartTimeoutMs({ AGENTINBOX_START_TIMEOUT_MS: "not-a-number" }), 60_000);
  assert.equal(resolveStartTimeoutMs({ AGENTINBOX_START_TIMEOUT_MS: "1500" }), 1_500);
});

test("autostartDisabled treats only explicit truthy values as disabled", () => {
  assert.equal(autostartDisabled({}), false);
  assert.equal(autostartDisabled({ AGENTINBOX_NO_AUTOSTART: "" }), false);
  assert.equal(autostartDisabled({ AGENTINBOX_NO_AUTOSTART: "0" }), false);
  assert.equal(autostartDisabled({ AGENTINBOX_NO_AUTOSTART: "false" }), false);
  assert.equal(autostartDisabled({ AGENTINBOX_NO_AUTOSTART: "1" }), true);
  assert.equal(autostartDisabled({ AGENTINBOX_NO_AUTOSTART: "true" }), true);
});

test("removePidFileIfOwned deletes only the caller's own pid file", () => {
  const home = tempHome("agentinbox-pid-ownership-home-");
  try {
    const pidPath = path.join(home, "agentinbox.pid");
    fs.writeFileSync(pidPath, "999999\n", "utf8");
    assert.equal(removePidFileIfOwned(pidPath, process.pid), false);
    assert.equal(fs.existsSync(pidPath), true);
    fs.writeFileSync(pidPath, `${process.pid}\n`, "utf8");
    assert.equal(removePidFileIfOwned(pidPath, process.pid), true);
    assert.equal(fs.existsSync(pidPath), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("serve exits 0 without binding when a live daemon holds the lock", () => {
  const home = tempHome("agentinbox-serve-locked-home-");
  const env = { ...process.env, AGENTINBOX_HOME: home };
  try {
    const started = runCli(["daemon", "start"], env);
    assert.equal(started.status, 0, started.stderr);
    const startedInfo = JSON.parse(started.stdout) as { started: boolean; pid: number };
    assert.equal(startedInfo.started, true);

    const socketPath = path.join(home, "agentinbox.sock");
    const secondServe = runCli(["serve"], env, 30_000);
    assert.equal(secondServe.status, 0, secondServe.stderr);
    assert.match(secondServe.stderr, /already running \(pid \d+\)/);

    // The running daemon is unaffected and still owns the lock.
    const holder = readDaemonLock(daemonLockPath(socketPath));
    assert.equal(holder?.pid, startedInfo.pid);
    const statusInfo = JSON.parse(runCli(["daemon", "status"], env).stdout) as {
      running: boolean;
      starting: boolean;
      pid: number | null;
    };
    assert.equal(statusInfo.running, true);
    assert.equal(statusInfo.starting, false);
    assert.equal(statusInfo.pid, startedInfo.pid);

    const stopped = runCli(["daemon", "stop"], env);
    assert.equal(stopped.status, 0, stopped.stderr);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("daemon start does not spawn when a live lock holder is starting", () => {
  const home = tempHome("agentinbox-start-wait-home-");
  const socketPath = path.join(home, "agentinbox.sock");
  const lockPath = daemonLockPath(socketPath);
  try {
    // Simulate a slow-starting daemon: this live process holds the lock but
    // never binds the socket.
    fs.writeFileSync(
      lockPath,
      JSON.stringify({ pid: process.pid, processStartedAt: null, acquiredAt: new Date().toISOString() }),
    );
    const env = {
      ...process.env,
      AGENTINBOX_HOME: home,
      AGENTINBOX_START_TIMEOUT_MS: "400",
    };
    const result = runCli(["daemon", "start"], env, 30_000);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, new RegExp(`already starting \\(pid ${process.pid}\\)`));
    // No competing daemon was spawned: no log file, no socket, pid file untouched.
    assert.equal(fs.existsSync(path.join(home, "agentinbox.log")), false);
    assert.equal(fs.existsSync(socketPath), false);
    assert.equal(fs.existsSync(path.join(home, "agentinbox.pid")), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("daemon status reports starting for a live pid without healthz and keeps files", async () => {
  const home = tempHome("agentinbox-status-starting-home-");
  const pidPath = path.join(home, "agentinbox.pid");
  const socketPath = path.join(home, "agentinbox.sock");
  try {
    fs.writeFileSync(pidPath, `${process.pid}\n`, "utf8");
    fs.writeFileSync(socketPath, ""); // stale socket file, nothing bound
    const status = await daemonStatus({ env: { ...process.env, AGENTINBOX_HOME: home } });
    assert.equal(status.running, false);
    assert.equal(status.starting, true);
    assert.equal(status.pid, process.pid);
    // Live pid: no cleanup of pid file or socket happens.
    assert.equal(fs.existsSync(pidPath), true);
    assert.equal(fs.existsSync(socketPath), true);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("daemon stop leaves files alone when another daemon still serves the socket", () => {
  const home = tempHome("agentinbox-stop-ownership-home-");
  const env = { ...process.env, AGENTINBOX_HOME: home };
  const pidPath = path.join(home, "agentinbox.pid");
  const lockPath = daemonLockPath(path.join(home, "agentinbox.sock"));
  try {
    const started = runCli(["daemon", "start"], env);
    assert.equal(started.status, 0, started.stderr);
    const startedInfo = JSON.parse(started.stdout) as { pid: number };

    // Simulate a pre-lock-version daemon still serving the socket: the lock
    // file is gone and the pid file was replaced by a foreign writer.
    fs.rmSync(lockPath, { force: true });
    fs.writeFileSync(pidPath, "999999\n", "utf8");
    const firstStop = runCli(["daemon", "stop"], env);
    assert.equal(firstStop.status, 0, firstStop.stderr);
    // The live daemon still serves healthz, so stop must not delete anything.
    assert.equal(fs.readFileSync(pidPath, "utf8").trim(), "999999");
    const stillRunning = JSON.parse(runCli(["daemon", "status"], env).stdout) as { running: boolean };
    assert.equal(stillRunning.running, true);

    // With the real pid restored, stop kills the daemon and cleans up.
    fs.writeFileSync(pidPath, `${startedInfo.pid}\n`, "utf8");
    const secondStop = runCli(["daemon", "stop"], env);
    assert.equal(secondStop.status, 0, secondStop.stderr);
    assert.equal(fs.existsSync(pidPath), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("daemon stop kills the lock holder when the pid file is stale", () => {
  const home = tempHome("agentinbox-stop-lock-fallback-home-");
  const env = { ...process.env, AGENTINBOX_HOME: home };
  const pidPath = path.join(home, "agentinbox.pid");
  const socketPath = path.join(home, "agentinbox.sock");
  const lockPath = daemonLockPath(socketPath);
  try {
    const started = runCli(["daemon", "start"], env);
    assert.equal(started.status, 0, started.stderr);

    // Stale foreign pid file; the live daemon still owns the admission lock.
    fs.writeFileSync(pidPath, "999999\n", "utf8");
    const stopped = runCli(["daemon", "stop"], env);
    assert.equal(stopped.status, 0, stopped.stderr);
    const statusInfo = JSON.parse(runCli(["daemon", "status"], env).stdout) as { running: boolean };
    assert.equal(statusInfo.running, false);
    assert.equal(fs.existsSync(pidPath), false);
    assert.equal(fs.existsSync(socketPath), false);
    assert.equal(fs.existsSync(lockPath), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("serve shutdown removes only its own pid file and releases its lock", async () => {
  const home = tempHome("agentinbox-serve-exit-home-");
  const env = { ...process.env, AGENTINBOX_HOME: home };
  const pidPath = path.join(home, "agentinbox.pid");
  const lockPath = daemonLockPath(path.join(home, "agentinbox.sock"));
  const child = spawn("node", ["-r", "ts-node/register", "src/cli.ts", "serve"], {
    cwd: REPO_DIR,
    env,
    stdio: "ignore",
  });
  try {
    const ready = await waitUntil(async () => (await daemonStatus({ env })).running === true, 45_000);
    assert.equal(ready, true, "serve did not become ready");
    assert.equal(fs.readFileSync(pidPath, "utf8").trim(), String(child.pid));

    // Simulate a foreign owner overwriting the pid file.
    fs.writeFileSync(pidPath, "999999\n", "utf8");
    child.kill("SIGTERM");
    assert.equal(await waitExit(child, 15_000), true, "serve did not exit after SIGTERM");

    // The foreign pid file survives; the lock is released by its real owner.
    assert.equal(fs.readFileSync(pidPath, "utf8").trim(), "999999");
    assert.equal(fs.existsSync(lockPath), false);
  } finally {
    if (child.exitCode == null) {
      child.kill("SIGKILL");
    }
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("AGENTINBOX_NO_AUTOSTART prevents implicit daemon spawning", () => {
  const home = tempHome("agentinbox-no-autostart-home-");
  const env = {
    ...process.env,
    AGENTINBOX_HOME: home,
    AGENTINBOX_NO_AUTOSTART: "1",
  };
  try {
    const result = runCli(["agent", "register"], env, 30_000);
    assert.notEqual(result.status, 0);
    assert.equal(fs.existsSync(path.join(home, "agentinbox.log")), false);
    assert.equal(fs.existsSync(path.join(home, "agentinbox.sock")), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("store open GCs orphan backup tmp files and keeps live-pid ones", async () => {
  const home = tempHome("agentinbox-store-gc-home-");
  const dbPath = path.join(home, "agentinbox.sqlite");
  // A separate live process owns a tmp file that GC must preserve (using the
  // test process pid would collide with backupHealthyDatabase's own tmp path).
  const liveOwner = spawn("sleep", ["30"]);
  assert.ok(liveOwner.pid, "failed to spawn live tmp owner");
  try {
    let store = await AgentInboxStore.open(dbPath);
    store.close();

    const orphanTmp = `${dbPath}.bak.999999.tmp`;
    const liveTmp = `${dbPath}.bak.${liveOwner.pid}.tmp`;
    fs.writeFileSync(orphanTmp, "orphan");
    fs.writeFileSync(liveTmp, "live");

    store = await AgentInboxStore.open(dbPath);
    store.close();
    assert.equal(fs.existsSync(orphanTmp), false, "orphan tmp should be garbage collected");
    assert.equal(fs.existsSync(liveTmp), true, "live-pid tmp must be preserved");
    assert.equal(fs.existsSync(`${dbPath}.bak`), true, "startup backup runs by default");

    fs.rmSync(liveTmp, { force: true });
    fs.rmSync(`${dbPath}.bak`, { force: true });
    store = await AgentInboxStore.open(dbPath, {
      env: { ...process.env, AGENTINBOX_STARTUP_BACKUP: "0" },
    });
    store.close();
    assert.equal(fs.existsSync(`${dbPath}.bak`), false, "AGENTINBOX_STARTUP_BACKUP=0 skips the backup");
  } finally {
    if (liveOwner.exitCode == null) {
      liveOwner.kill("SIGKILL");
    }
    fs.rmSync(home, { recursive: true, force: true });
  }
});
