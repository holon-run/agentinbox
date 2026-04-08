import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { AgentInboxClient } from "./client";
import { resolveAgentInboxHome, resolveDaemonPaths, type ClientTransport } from "./paths";

export interface DaemonCliOptions {
  env?: NodeJS.ProcessEnv;
  homeDirOverride?: string;
  socketPathOverride?: string;
  baseUrlOverride?: string;
  noAutoStart?: boolean;
}

export interface DaemonStartResult {
  started: boolean;
  pid: number;
  pidPath: string;
  logPath: string;
  transport: ClientTransport;
}

export interface DaemonStatusResult {
  running: boolean;
  pid: number | null;
  pidPath: string;
  logPath: string;
  transport: ClientTransport;
}

const START_TIMEOUT_MS = 15_000;

export async function ensureDaemonForClient(options: DaemonCliOptions = {}): Promise<ClientTransport> {
  const transport = resolveDaemonClientTransport(options);

  if (options.noAutoStart || transport.kind !== "socket") {
    return transport;
  }

  if (await canReachHealthz(transport)) {
    return transport;
  }

  await startDaemon(options);
  return transport;
}

export async function startDaemon(options: DaemonCliOptions = {}): Promise<DaemonStartResult> {
  const env = options.env ?? process.env;
  const transport = requireSocketTransport(resolveDaemonClientTransport(options), "daemon start");

  const homeDir = resolveAgentInboxHome(env, options.homeDirOverride);
  const { pidPath, logPath } = resolveDaemonPaths(env, options.homeDirOverride);
  fs.mkdirSync(homeDir, { recursive: true });
  cleanupStalePidFile(pidPath);

  if (await canReachHealthz(transport)) {
    const pid = readPidFile(pidPath);
    return {
      started: false,
      pid: pid ?? -1,
      pidPath,
      logPath,
      transport,
    };
  }

  const logFd = openLogFile(logPath);
  let child;
  try {
    child = spawn(process.execPath, daemonChildArgs(), {
      cwd: process.cwd(),
      env: {
        ...env,
        AGENTINBOX_HOME: homeDir,
        AGENTINBOX_SOCKET: transport.socketPath,
        AGENTINBOX_URL: "",
      },
      detached: true,
      stdio: ["ignore", logFd, logFd],
    });
  } finally {
    fs.closeSync(logFd);
  }
  child.unref();
  await waitForHealthz(transport, START_TIMEOUT_MS);
  return {
    started: true,
    pid: child.pid ?? -1,
    pidPath,
    logPath,
    transport,
  };
}

export async function stopDaemon(options: DaemonCliOptions = {}): Promise<DaemonStatusResult> {
  const env = options.env ?? process.env;
  const transport = requireSocketTransport(resolveDaemonClientTransport(options), "daemon stop");
  const { pidPath, logPath } = resolveDaemonPaths(env, options.homeDirOverride);

  const pid = readPidFile(pidPath);
  if (pid != null && isProcessAlive(pid)) {
    process.kill(pid, "SIGTERM");
    await waitForProcessExit(pid, 3_000);
  }

  cleanupStalePidFile(pidPath, true);
  cleanupFile(transport.socketPath);

  return daemonStatus(options);
}

export async function daemonStatus(options: DaemonCliOptions = {}): Promise<DaemonStatusResult> {
  const env = options.env ?? process.env;
  const transport = requireSocketTransport(resolveDaemonClientTransport(options), "daemon status");
  const { pidPath, logPath } = resolveDaemonPaths(env, options.homeDirOverride);
  const pid = readPidFile(pidPath);
  if (pid != null && !isProcessAlive(pid)) {
    cleanupStalePidFile(pidPath, true);
    cleanupFile(transport.socketPath);
    return {
      running: false,
      pid: null,
      pidPath,
      logPath,
      transport,
    };
  }

  return {
    running: await canReachHealthz(transport),
    pid,
    pidPath,
    logPath,
    transport,
  };
}

export function writePidFile(pidPath: string, pid: number): void {
  fs.mkdirSync(path.dirname(pidPath), { recursive: true });
  fs.writeFileSync(pidPath, `${pid}\n`, "utf8");
}

export function removePidFile(pidPath: string): void {
  cleanupFile(pidPath);
}

function daemonChildArgs(): string[] {
  const execArgv = [...process.execArgv];
  return [...execArgv, process.argv[1], "serve"];
}

function requireSocketTransport(
  transport: ClientTransport,
  commandName: string,
): Extract<ClientTransport, { kind: "socket" }> {
  if (transport.kind !== "socket") {
    throw new Error(`${commandName} requires a local socket transport`);
  }
  return transport;
}

function resolveDaemonClientTransport(options: DaemonCliOptions): ClientTransport {
  const env = options.env ?? process.env;
  const homeDir = resolveAgentInboxHome(env, options.homeDirOverride);

  if (options.socketPathOverride && options.baseUrlOverride) {
    throw new Error("client accepts either --socket or --url, not both");
  }

  if (options.socketPathOverride) {
    return {
      kind: "socket",
      socketPath: path.resolve(options.socketPathOverride),
      source: "flag",
    };
  }
  if (options.baseUrlOverride) {
    return {
      kind: "url",
      baseUrl: options.baseUrlOverride,
      source: "flag",
    };
  }
  if (env.AGENTINBOX_SOCKET) {
    return {
      kind: "socket",
      socketPath: path.resolve(env.AGENTINBOX_SOCKET),
      source: "env",
    };
  }
  if (env.AGENTINBOX_URL) {
    return {
      kind: "url",
      baseUrl: env.AGENTINBOX_URL,
      source: "env",
    };
  }
  return {
    kind: "socket",
    socketPath: path.join(homeDir, "agentinbox.sock"),
    source: "default",
  };
}

function openLogFile(logPath: string): number {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  return fs.openSync(logPath, "a");
}

async function canReachHealthz(transport: ClientTransport): Promise<boolean> {
  try {
    const client = new AgentInboxClient(transport);
    const response = await client.request<{ ok: boolean }>("/healthz", undefined, "GET");
    return response.statusCode === 200 && response.data.ok === true;
  } catch {
    return false;
  }
}

async function waitForHealthz(transport: ClientTransport, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await canReachHealthz(transport)) {
      return;
    }
    await sleep(100);
  }
  throw new Error("timed out waiting for AgentInbox daemon to become ready");
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (!isProcessAlive(pid)) {
      return;
    }
    await sleep(100);
  }
  throw new Error(`timed out waiting for process ${pid} to exit`);
}

function cleanupStalePidFile(pidPath: string, force = false): void {
  const pid = readPidFile(pidPath);
  if (pid == null) {
    cleanupFile(pidPath);
    return;
  }
  if (force || !isProcessAlive(pid)) {
    cleanupFile(pidPath);
  }
}

function readPidFile(pidPath: string): number | null {
  try {
    const raw = fs.readFileSync(pidPath, "utf8").trim();
    if (!raw) {
      return null;
    }
    const pid = Number.parseInt(raw, 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function cleanupFile(filePath: string): void {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch {
    // Best effort cleanup.
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
