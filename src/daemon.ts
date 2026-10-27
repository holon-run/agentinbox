import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { AgentInboxClient } from "./client";
import { daemonLockPath, resolveAgentInboxHome, resolveDaemonPaths, type ClientTransport } from "./paths";
import { readOwnPackageVersion } from "./version";
import { defaultLogLevel, isLogLevel, LogLevel, parseLogLevel } from "./logging";
import { isEnvFlagEnabled, isPidAlive } from "./util";

export interface DaemonCliOptions {
  env?: NodeJS.ProcessEnv;
  homeDirOverride?: string;
  socketPathOverride?: string;
  baseUrlOverride?: string;
  logLevelOverride?: LogLevel;
  noAutoStart?: boolean;
}

export interface DaemonStartResult {
  started: boolean;
  pid: number;
  logLevel: LogLevel;
  pidPath: string;
  logPath: string;
  transport: ClientTransport;
}

export interface DaemonStatusResult {
  running: boolean;
  /** A daemon process exists but healthz is not ready yet (e.g. opening a large store). */
  starting: boolean;
  pid: number | null;
  logLevel: LogLevel | null;
  /**
   * Daemon build version self-reported over healthz. Legacy alias of
   * `daemonVersion`; never the calling CLI's version. Null when the daemon
   * does not report one (e.g. builds predating #269) or is not running.
   */
  version: string | null;
  /** Daemon build version self-reported over healthz; null when unknown. */
  daemonVersion: string | null;
  /** Version of the AgentInbox install this CLI call runs from. */
  cliVersion: string | null;
  startedAt: string | null;
  command: string | null;
  nodeVersion: string | null;
  pidPath: string;
  logPath: string;
  transport: ClientTransport;
}

const DEFAULT_START_TIMEOUT_MS = 60_000;
// A freshly created but still-empty lock file may belong to a process between
// create and write; never steal it within this grace window.
const STALE_LOCK_GRACE_MS = 5_000;
const PACKAGE_VERSION = readOwnPackageVersion();

/** AGENTINBOX_NO_AUTOSTART disables implicit daemon spawning (systemd-style deployments). */
export function autostartDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isEnvFlagEnabled(env.AGENTINBOX_NO_AUTOSTART);
}

export async function ensureDaemonForClient(options: DaemonCliOptions = {}): Promise<ClientTransport> {
  const env = options.env ?? process.env;
  const transport = resolveDaemonClientTransport(options);

  if (options.noAutoStart || autostartDisabled(env) || transport.kind !== "socket") {
    return transport;
  }

  const health = await fetchDaemonHealth(transport);
  if (health?.ok === true) {
    emitDaemonVersionMismatch(health.version);
    return transport;
  }

  await startDaemon(options);
  return transport;
}

export async function startDaemon(options: DaemonCliOptions = {}): Promise<DaemonStartResult> {
  const env = options.env ?? process.env;
  const transport = requireSocketTransport(resolveDaemonClientTransport(options), "daemon start");
  const logLevel = resolveDaemonLogLevel(env, options.logLevelOverride);

  const homeDir = resolveAgentInboxHome(env, options.homeDirOverride);
  const { pidPath, logPath } = resolveDaemonPaths(env, options.homeDirOverride);
  fs.mkdirSync(homeDir, { recursive: true });

  const health = await fetchDaemonHealth(transport);
  if (health?.ok === true) {
    emitDaemonVersionMismatch(health.version);
    const pid = readPidFile(pidPath);
    return {
      started: false,
      pid: pid ?? -1,
      logLevel,
      pidPath,
      logPath,
      transport,
    };
  }

  // Admission: a live lock holder is starting (or serving) this socket — never
  // spawn a competing daemon. This check is advisory; the spawned serve
  // process enforces the lock authoritatively.
  const lockPath = daemonLockPath(transport.socketPath);
  const timeoutMs = resolveStartTimeoutMs(env);
  let pendingHolder = readLiveDaemonLockHolder(lockPath);
  while (pendingHolder) {
    const outcome = await waitForDaemonReady(transport, lockPath, timeoutMs);
    if (outcome === "ready") {
      emitDaemonVersionMismatch((await fetchDaemonHealth(transport))?.version ?? null);
      const pid = readPidFile(pidPath) ?? pendingHolder.pid;
      return {
        started: false,
        pid,
        logLevel,
        pidPath,
        logPath,
        transport,
      };
    }
    if (outcome === "timeout") {
      throw new Error(
        `AgentInbox daemon is already starting (pid ${pendingHolder.pid}) but did not become ready within ${timeoutMs}ms`,
      );
    }
    // The pending holder exited before becoming ready; re-check admission.
    pendingHolder = readLiveDaemonLockHolder(lockPath);
  }

  // Resolve the daemon install before creating any files so an unusable
  // entry fails explicitly without side effects (#269).
  const daemonEntry = resolveDaemonEntry(env);
  const logFd = openLogFile(logPath);
  let child;
  try {
    child = spawn(process.execPath, daemonChildArgs(daemonEntry), {
      cwd: process.cwd(),
      env: {
        ...env,
        AGENTINBOX_HOME: homeDir,
        AGENTINBOX_SOCKET: transport.socketPath,
        AGENTINBOX_URL: "",
        AGENTINBOX_LOG_LEVEL: logLevel,
      },
      detached: true,
      stdio: ["ignore", logFd, logFd],
    });
  } finally {
    fs.closeSync(logFd);
  }
  child.unref();
  await waitForHealthz(transport, timeoutMs);
  return {
    started: true,
    pid: child.pid ?? -1,
    logLevel,
    pidPath,
    logPath,
    transport,
  };
}

export async function stopDaemon(options: DaemonCliOptions = {}): Promise<DaemonStatusResult> {
  const env = options.env ?? process.env;
  const transport = requireSocketTransport(resolveDaemonClientTransport(options), "daemon stop");
  const { pidPath, logPath, metadataPath } = resolveDaemonPaths(env, options.homeDirOverride);

  let pid = readPidFile(pidPath);
  if (pid == null || !isPidAlive(pid)) {
    // The pid file may be stale or overwritten while the live daemon still
    // owns the socket; fall back to the admission lock holder.
    pid = readLiveDaemonLockHolder(daemonLockPath(transport.socketPath))?.pid ?? pid;
  }
  if (pid != null && isPidAlive(pid)) {
    process.kill(pid, "SIGTERM");
    await waitForProcessExit(pid, 3_000);
  }

  // Ownership: if an instance we did not stop still serves the socket, the
  // files may now belong to it — leave them untouched. Otherwise remove the
  // pid file only when it no longer references a live process.
  if (!(await canReachHealthz(transport))) {
    cleanupStalePidFile(pidPath);
    cleanupFile(transport.socketPath);
    cleanupFile(metadataPath);
  }

  return daemonStatus(options);
}

export async function daemonStatus(options: DaemonCliOptions = {}): Promise<DaemonStatusResult> {
  const env = options.env ?? process.env;
  const transport = requireSocketTransport(resolveDaemonClientTransport(options), "daemon status");
  const { pidPath, logPath, metadataPath } = resolveDaemonPaths(env, options.homeDirOverride);
  let pid = readPidFile(pidPath);
  if (pid != null && !isPidAlive(pid)) {
    const holder = readLiveDaemonLockHolder(daemonLockPath(transport.socketPath));
    if (holder != null) {
      // The admission lock identifies the live daemon even when the pid file
      // is stale (e.g. overwritten by a mixed-version writer).
      pid = holder.pid;
    } else if (!(await canReachHealthz(transport))) {
      // Nothing is serving and no live owner exists: clean stale files.
      cleanupStalePidFile(pidPath);
      cleanupFile(transport.socketPath);
      cleanupFile(metadataPath);
      return {
        running: false,
        starting: false,
        pid: null,
        logLevel: null,
        version: null,
        daemonVersion: null,
        cliVersion: PACKAGE_VERSION,
        startedAt: null,
        command: null,
        nodeVersion: null,
        pidPath,
        logPath,
        transport,
      };
    } else {
      // Something answers healthz (e.g. an older daemon without a lock);
      // report it without owning its files.
      pid = null;
    }
  }

  const processInfo = pid == null ? null : readProcessMetadata(pid);
  const daemonMetadata = readDaemonMetadata(metadataPath);
  const health = await fetchDaemonHealth(transport);
  const running = health?.ok === true;
  const daemonVersion = health?.version ?? null;
  return {
    running,
    starting: !running && pid != null && isPidAlive(pid),
    pid,
    logLevel: daemonMetadata?.logLevel ?? null,
    version: daemonVersion,
    daemonVersion,
    cliVersion: PACKAGE_VERSION,
    startedAt: processInfo?.startedAt ?? null,
    command: processInfo?.command ?? null,
    nodeVersion: processInfo?.nodeVersion ?? null,
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

/** Removes the pid file only when it still belongs to the given pid. */
export function removePidFileIfOwned(pidPath: string, pid: number): boolean {
  if (readPidFile(pidPath) !== pid) {
    return false;
  }
  cleanupFile(pidPath);
  return true;
}

export interface DaemonLockInfo {
  pid: number;
  /** Process start time (ps lstart) captured at acquire time; guards against pid reuse. */
  processStartedAt: string | null;
  acquiredAt: string;
}

export interface DaemonLockAcquisition {
  acquired: boolean;
  lockPath: string;
  holder: DaemonLockInfo | null;
}

export function readDaemonLock(lockPath: string): DaemonLockInfo | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(lockPath, "utf8")) as {
      pid?: unknown;
      processStartedAt?: unknown;
      acquiredAt?: unknown;
    };
    if (typeof parsed.pid !== "number" || !Number.isInteger(parsed.pid) || parsed.pid <= 0) {
      return null;
    }
    return {
      pid: parsed.pid,
      processStartedAt: typeof parsed.processStartedAt === "string" ? parsed.processStartedAt : null,
      acquiredAt: typeof parsed.acquiredAt === "string" ? parsed.acquiredAt : new Date(0).toISOString(),
    };
  } catch {
    return null;
  }
}

export function isLockHolderLive(holder: DaemonLockInfo): boolean {
  if (!isPidAlive(holder.pid)) {
    return false;
  }
  if (holder.processStartedAt == null) {
    return true;
  }
  const current = readProcessMetadata(holder.pid);
  if (current?.startedAt == null) {
    return true;
  }
  return current.startedAt === holder.processStartedAt;
}

export function readLiveDaemonLockHolder(lockPath: string): DaemonLockInfo | null {
  const holder = readDaemonLock(lockPath);
  return holder != null && isLockHolderLive(holder) ? holder : null;
}

/**
 * Atomically (O_EXCL) acquires the daemon admission lock for this process.
 * A stale lock (dead pid or pid reuse) is removed and retried once. A freshly
 * created but still-empty lock is treated as held to avoid racing a concurrent
 * creator between create and write.
 */
export function acquireDaemonLock(lockPath: string): DaemonLockAcquisition {
  let holder: DaemonLockInfo | null = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    holder = null;
    try {
      const metadata = readProcessMetadata(process.pid);
      const info: DaemonLockInfo = {
        pid: process.pid,
        processStartedAt: metadata?.startedAt ?? null,
        acquiredAt: new Date().toISOString(),
      };
      fs.writeFileSync(lockPath, `${JSON.stringify(info)}\n`, { encoding: "utf8", flag: "wx" });
      return { acquired: true, lockPath, holder: null };
    } catch (error) {
      if (!isFileExistsError(error)) {
        throw error;
      }
    }
    holder = readDaemonLock(lockPath);
    if (holder != null && isLockHolderLive(holder)) {
      return { acquired: false, lockPath, holder };
    }
    if (holder == null && isLockFileFresh(lockPath)) {
      return { acquired: false, lockPath, holder: null };
    }
    cleanupFile(lockPath);
  }
  return { acquired: false, lockPath, holder };
}

/** Releases the lock only when it still belongs to the given pid. */
export function releaseDaemonLock(lockPath: string, pid: number): void {
  const holder = readDaemonLock(lockPath);
  if (holder?.pid === pid) {
    cleanupFile(lockPath);
  }
}

export function resolveStartTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.AGENTINBOX_START_TIMEOUT_MS;
  if (raw == null || raw.trim() === "") {
    return DEFAULT_START_TIMEOUT_MS;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_START_TIMEOUT_MS;
}

function isFileExistsError(error: unknown): boolean {
  return typeof error === "object" && error != null && (error as { code?: unknown }).code === "EEXIST";
}

function isLockFileFresh(lockPath: string): boolean {
  try {
    return Date.now() - fs.statSync(lockPath).mtimeMs < STALE_LOCK_GRACE_MS;
  } catch {
    return false;
  }
}

type DaemonReadyOutcome = "ready" | "lost" | "timeout";

/**
 * Waits for the daemon holding the lock to serve healthz. Returns "lost" when
 * the holder disappears without becoming ready so the caller can re-check
 * admission instead of timing out.
 */
async function waitForDaemonReady(
  transport: ClientTransport,
  lockPath: string,
  timeoutMs: number,
): Promise<DaemonReadyOutcome> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await canReachHealthz(transport)) {
      return "ready";
    }
    if (readLiveDaemonLockHolder(lockPath) == null) {
      return "lost";
    }
    await sleep(100);
  }
  return "timeout";
}

/**
 * Resolves the entry script used to spawn the daemon.
 *
 * The daemon build must not be inherited from whichever CLI client happens to
 * call first (#269): the entry is resolved structurally from this module's
 * own install, or from AGENTINBOX_DAEMON_ENTRY when a deployment pins an
 * explicit daemon install. An unusable resolved entry fails explicitly; there
 * is no silent fallback to the caller's `process.argv[1]`.
 */
export function resolveDaemonEntry(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.AGENTINBOX_DAEMON_ENTRY?.trim();
  if (explicit) {
    const entry = path.resolve(explicit);
    if (!fs.existsSync(entry)) {
      throw new Error(`AGENTINBOX_DAEMON_ENTRY points to a missing daemon entry: ${entry}`);
    }
    return entry;
  }
  // Compiled layout: dist/src/cli.js next to dist/src/daemon.js; ts-node dev
  // layout: src/cli.ts next to src/daemon.ts.
  for (const entry of [path.join(__dirname, "cli.js"), path.join(__dirname, "cli.ts")]) {
    if (fs.existsSync(entry)) {
      return entry;
    }
  }
  throw new Error(
    `cannot resolve an AgentInbox daemon entry next to ${__dirname}; set AGENTINBOX_DAEMON_ENTRY to a CLI entry script`,
  );
}

function daemonChildArgs(daemonEntry: string): string[] {
  const execArgv = [...process.execArgv];
  return [...execArgv, daemonEntry, "serve"];
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

interface DaemonHealthInfo {
  ok: boolean;
  /** Daemon self-reported build version; null when the daemon omits it (pre-#269 builds). */
  version: string | null;
}

/**
 * Probes healthz and returns the daemon's self-reported health, or null when
 * the socket is unreachable or the response is not healthy.
 */
async function fetchDaemonHealth(transport: ClientTransport): Promise<DaemonHealthInfo | null> {
  try {
    const client = new AgentInboxClient(transport);
    const response = await client.request<{ ok?: unknown; version?: unknown }>("/healthz", undefined, "GET");
    if (response.statusCode !== 200) {
      return null;
    }
    const body = response.data;
    if (typeof body !== "object" || body === null || body.ok !== true) {
      return null;
    }
    return {
      ok: true,
      version: typeof body.version === "string" && body.version.length > 0 ? body.version : null,
    };
  } catch {
    return null;
  }
}

async function canReachHealthz(transport: ClientTransport): Promise<boolean> {
  return (await fetchDaemonHealth(transport))?.ok === true;
}

/**
 * Returns a warning line when the running daemon reports a different build
 * version than this CLI, so silent mixed-build takeovers stay visible (#269).
 */
export function daemonVersionMismatchMessage(
  daemonVersion: string | null,
  cliVersion: string | null,
): string | null {
  if (daemonVersion == null || cliVersion == null || daemonVersion === cliVersion) {
    return null;
  }
  return (
    `warning: AgentInbox daemon version ${daemonVersion} differs from CLI version ${cliVersion}; ` +
    `the running daemon is kept as-is. Restart it from the intended install, or set ` +
    `AGENTINBOX_DAEMON_ENTRY to pin the autostart build.`
  );
}

function emitDaemonVersionMismatch(daemonVersion: string | null): void {
  const message = daemonVersionMismatchMessage(daemonVersion, PACKAGE_VERSION);
  if (message != null) {
    console.error(message);
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
    if (!isPidAlive(pid)) {
      return;
    }
    await sleep(100);
  }
  throw new Error(`timed out waiting for process ${pid} to exit`);
}

function cleanupStalePidFile(pidPath: string): void {
  const pid = readPidFile(pidPath);
  if (pid == null) {
    cleanupFile(pidPath);
    return;
  }
  if (!isPidAlive(pid)) {
    cleanupFile(pidPath);
  }
}

export function resolveDaemonLogLevel(
  env: NodeJS.ProcessEnv = process.env,
  override?: LogLevel,
): LogLevel {
  if (override) {
    return override;
  }
  return parseLogLevel(env.AGENTINBOX_LOG_LEVEL, defaultLogLevel());
}

export function writeDaemonMetadata(
  metadataPath: string,
  metadata: { logLevel: LogLevel },
): void {
  fs.mkdirSync(path.dirname(metadataPath), { recursive: true });
  fs.writeFileSync(metadataPath, JSON.stringify(metadata), "utf8");
}

function readDaemonMetadata(metadataPath: string): { logLevel: LogLevel } | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(metadataPath, "utf8")) as { logLevel?: unknown };
    if (isLogLevel(parsed.logLevel)) {
      return { logLevel: parsed.logLevel };
    }
    return null;
  } catch {
    return null;
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

function readProcessMetadata(pid: number): {
  startedAt: string | null;
  command: string | null;
  nodeVersion: string | null;
} | null {
  try {
    const output = execFileSync("ps", ["-o", "lstart=", "-o", "command=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trimEnd();
    if (!output) {
      return null;
    }
    const firstNonSpace = output.search(/\S/);
    if (firstNonSpace < 0) {
      return null;
    }
    const trimmed = output.slice(firstNonSpace);
    const match = trimmed.match(/^([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d\d:\d\d:\d\d\s+\d{4})\s+(.*)$/);
    if (!match) {
      return {
        startedAt: null,
        command: trimmed,
        nodeVersion: inferNodeVersionFromCommand(trimmed),
      };
    }
    const [, startedAtRaw, command] = match;
    const startedAtMs = Date.parse(startedAtRaw);
    return {
      startedAt: Number.isNaN(startedAtMs) ? null : new Date(startedAtMs).toISOString(),
      command: command || null,
      nodeVersion: inferNodeVersionFromCommand(command),
    };
  } catch {
    return null;
  }
}

function inferNodeVersionFromCommand(command: string | null): string | null {
  if (!command) {
    return null;
  }
  const match = command.match(/node\/(v\d+\.\d+\.\d+)\//);
  return match ? match[1] : null;
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
