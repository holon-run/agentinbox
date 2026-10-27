import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { daemonStatus, daemonVersionMismatchMessage, resolveDaemonEntry } from "../src/daemon";
import { readOwnPackageVersion } from "../src/version";
import { AgentInboxClient } from "../src/client";

const REPO_DIR = path.resolve(__dirname, "..");
const REPO_VERSION = readOwnPackageVersion();

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
    await sleep(100);
  }
  return false;
}

/**
 * Spawns a stub daemon on a unix socket that answers /healthz like an older
 * (version: null) or mismatched (version: <given>) AgentInbox build would.
 */
function startStubDaemon(socketPath: string, version: string | null): ChildProcess {
  const script = `
const http = require("node:http");
const fs = require("node:fs");
const socketPath = process.argv[1];
const version = process.argv[2];
try { fs.unlinkSync(socketPath); } catch {}
const server = http.createServer((req, res) => {
  if (req.url === "/healthz") {
    const body = { ok: true };
    if (version !== "none") body.version = version;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(body));
    return;
  }
  res.statusCode = 404;
  res.end("{}");
});
server.listen(socketPath);
`;
  return spawn(process.execPath, ["-e", script, socketPath, version ?? "none"], {
    stdio: ["ignore", "ignore", "inherit"],
  });
}

async function waitStubReady(socketPath: string): Promise<void> {
  const client = new AgentInboxClient({ kind: "socket", socketPath, source: "default" });
  const ready = await waitUntil(async () => {
    try {
      const response = await client.request("/healthz", undefined, "GET");
      return response.statusCode === 200;
    } catch {
      return false;
    }
  }, 10_000);
  assert.equal(ready, true, "stub daemon did not become ready");
}

test("readOwnPackageVersion resolves this repository's version", () => {
  assert.ok(typeof REPO_VERSION === "string" && REPO_VERSION.length > 0);
});

test("daemonVersionMismatchMessage stays silent on equal or unknown versions", () => {
  assert.equal(daemonVersionMismatchMessage(null, "1.0.0"), null);
  assert.equal(daemonVersionMismatchMessage("1.0.0", null), null);
  assert.equal(daemonVersionMismatchMessage("1.0.0", "1.0.0"), null);
  const message = daemonVersionMismatchMessage("1.0.0", "2.0.0");
  assert.match(message ?? "", /daemon version 1\.0\.0 differs from CLI version 2\.0\.0/);
});

test("resolveDaemonEntry honors AGENTINBOX_DAEMON_ENTRY and fails on a missing entry", () => {
  const entry = resolveDaemonEntry({ AGENTINBOX_DAEMON_ENTRY: path.join(REPO_DIR, "src", "cli.ts") });
  assert.equal(entry, path.join(REPO_DIR, "src", "cli.ts"));

  assert.throws(
    () => resolveDaemonEntry({ AGENTINBOX_DAEMON_ENTRY: path.join(REPO_DIR, "definitely-missing.js") }),
    /AGENTINBOX_DAEMON_ENTRY points to a missing daemon entry/,
  );
  // The default resolution stays inside this module's own install.
  const fallback = resolveDaemonEntry({});
  assert.ok(fallback === path.join(REPO_DIR, "src", "cli.ts") || fallback === path.join(REPO_DIR, "dist", "src", "cli.js"));
});

test("daemon status reports the daemon's self-reported build version", () => {
  const home = tempHome("agentinbox-version-self-home-");
  const env = { ...process.env, AGENTINBOX_HOME: home };
  try {
    const started = runCli(["daemon", "start"], env);
    assert.equal(started.status, 0, started.stderr);
    const statusInfo = JSON.parse(runCli(["daemon", "status"], env).stdout) as {
      running: boolean;
      version: string | null;
      daemonVersion: string | null;
      cliVersion: string | null;
    };
    assert.equal(statusInfo.running, true);
    assert.equal(statusInfo.daemonVersion, REPO_VERSION);
    assert.equal(statusInfo.version, REPO_VERSION);
    assert.equal(statusInfo.cliVersion, REPO_VERSION);
    const stopped = runCli(["daemon", "stop"], env);
    assert.equal(stopped.status, 0, stopped.stderr);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("daemon status reports null daemon version against an old daemon that does not self-report", async () => {
  const home = tempHome("agentinbox-version-old-home-");
  const socketPath = path.join(home, "agentinbox.sock");
  const stub = startStubDaemon(socketPath, null);
  try {
    await waitStubReady(socketPath);
    // No pid file: daemonStatus must still observe the serving daemon and
    // must not backfill the daemon version with the calling CLI's version.
    const status = await daemonStatus({ env: { ...process.env, AGENTINBOX_HOME: home } });
    assert.equal(status.running, true);
    assert.equal(status.daemonVersion, null);
    assert.equal(status.version, null);
    assert.equal(status.cliVersion, REPO_VERSION);
  } finally {
    stub.kill("SIGTERM");
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("daemon status surfaces a mismatching daemon build version from healthz", async () => {
  const home = tempHome("agentinbox-version-mixed-home-");
  const socketPath = path.join(home, "agentinbox.sock");
  const stub = startStubDaemon(socketPath, "0.0.0-stub");
  try {
    await waitStubReady(socketPath);
    const status = await daemonStatus({ env: { ...process.env, AGENTINBOX_HOME: home } });
    assert.equal(status.running, true);
    assert.equal(status.daemonVersion, "0.0.0-stub");
    assert.equal(status.version, "0.0.0-stub");
    assert.equal(status.cliVersion, REPO_VERSION);
    assert.notEqual(status.daemonVersion, status.cliVersion);
  } finally {
    stub.kill("SIGTERM");
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("daemon start warns on stderr when the running daemon reports a different version", async () => {
  const home = tempHome("agentinbox-version-warn-home-");
  const socketPath = path.join(home, "agentinbox.sock");
  const stub = startStubDaemon(socketPath, "0.0.0-stub");
  try {
    await waitStubReady(socketPath);
    const env = { ...process.env, AGENTINBOX_HOME: home };
    const result = runCli(["daemon", "start"], env);
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout) as { started: boolean };
    assert.equal(parsed.started, false);
    assert.match(result.stderr ?? "", new RegExp(`daemon version 0\\.0\\.0-stub differs from CLI version ${REPO_VERSION}`));
  } finally {
    stub.kill("SIGTERM");
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("AGENTINBOX_DAEMON_ENTRY selects the spawned daemon entry", () => {
  const home = tempHome("agentinbox-version-entry-home-");
  const entry = path.join(REPO_DIR, "src", "cli.ts");
  const env = { ...process.env, AGENTINBOX_HOME: home, AGENTINBOX_DAEMON_ENTRY: entry };
  try {
    const started = runCli(["daemon", "start"], env);
    assert.equal(started.status, 0, started.stderr);
    const startedInfo = JSON.parse(started.stdout) as { started: boolean; pid: number };
    assert.equal(startedInfo.started, true);

    const status = JSON.parse(runCli(["daemon", "status"], env).stdout) as {
      running: boolean;
      pid: number | null;
      command: string | null;
      daemonVersion: string | null;
    };
    assert.equal(status.running, true);
    assert.equal(status.pid, startedInfo.pid);
    assert.ok(status.command?.includes("cli.ts"), `spawned command should use the pinned entry: ${status.command}`);
    assert.equal(status.daemonVersion, REPO_VERSION);

    const stopped = runCli(["daemon", "stop"], env);
    assert.equal(stopped.status, 0, stopped.stderr);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("AGENTINBOX_DAEMON_ENTRY pointing at a missing file fails explicitly without spawning", () => {
  const home = tempHome("agentinbox-version-badentry-home-");
  const env = {
    ...process.env,
    AGENTINBOX_HOME: home,
    AGENTINBOX_DAEMON_ENTRY: path.join(home, "missing-entry.js"),
  };
  try {
    const result = runCli(["daemon", "start"], env);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /AGENTINBOX_DAEMON_ENTRY points to a missing daemon entry/);
    // Nothing was spawned and no daemon state files were created.
    assert.equal(fs.existsSync(path.join(home, "agentinbox.pid")), false);
    assert.equal(fs.existsSync(path.join(home, "agentinbox.sock")), false);
    assert.equal(fs.existsSync(path.join(home, "agentinbox.log")), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
