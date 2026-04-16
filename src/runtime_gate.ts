import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { TerminalActivationTarget } from "./model";

const execFileAsync = promisify(execFile);
const DEFAULT_ITERM2_SAMPLE_DELAY_MS = 900;
const DEFAULT_TMUX_SAMPLE_DELAY_MS = 900;
const ACTIVE_BUFFER_MARKERS = [
  "esc to interrupt",
  "Working (",
  "⠼ ",
];
const TYPING_PROMPT_PREFIXES = [
  "› ",
  "> ",
];

type ExecFileAsyncLike = (
  file: string,
  args: readonly string[],
  options?: {
    env?: NodeJS.ProcessEnv;
  },
) => Promise<{ stdout: string; stderr: string }>;

export type RuntimePresenceStatus = "alive" | "unknown" | "gone";
export type TerminalBusyStatus = "busy" | "idle" | "unknown";
export type TerminalPresenceStatus = "available" | "unknown" | "gone";

export interface RuntimePresenceProbe {
  supports(target: TerminalActivationTarget): boolean;
  check(target: TerminalActivationTarget): Promise<RuntimePresenceStatus>;
}

export interface TerminalStateProbe {
  supports(target: TerminalActivationTarget): boolean;
  check(target: TerminalActivationTarget): Promise<{
    presence: TerminalPresenceStatus;
    busy: TerminalBusyStatus;
  }>;
}

export interface ActivationGate {
  evaluate(target: TerminalActivationTarget): Promise<{
    outcome: "inject" | "defer" | "offline";
    reason: string;
  }>;
}

export class DefaultActivationGate implements ActivationGate {
  constructor(
    private readonly runtimeProbes: RuntimePresenceProbe[] = [
      new CodexRuntimePresenceProbe(),
      new ClaudeCodeRuntimePresenceProbe(),
    ],
    private readonly terminalProbes: TerminalStateProbe[] = [
      new CodexTerminalStateProbe(),
      new Iterm2TerminalStateProbe(),
      new ClaudeCodeTerminalStateProbe(),
      new TmuxTerminalStateProbe(),
    ],
  ) {}

  async evaluate(target: TerminalActivationTarget): Promise<{
    outcome: "inject" | "defer" | "offline";
    reason: string;
  }> {
    const runtimeProbe = this.runtimeProbes.find((probe) => probe.supports(target));
    const runtimePresence = runtimeProbe ? await runtimeProbe.check(target) : "unknown";
    if (runtimePresence === "gone") {
      return { outcome: "offline", reason: "runtime_gone" };
    }
    const terminalProbe = this.terminalProbes.find((probe) => probe.supports(target));
    const terminalState = terminalProbe
      ? await terminalProbe.check(target)
      : { presence: "unknown" as const, busy: "unknown" as const };

    if (terminalState.presence === "gone") {
      return { outcome: "offline", reason: "terminal_gone" };
    }
    if (terminalState.busy === "busy") {
      return { outcome: "defer", reason: "terminal_busy" };
    }
    if (target.runtimeKind === "codex" && terminalState.busy === "idle") {
      return { outcome: "defer", reason: "terminal_recently_active" };
    }
    return { outcome: "inject", reason: "gate_unknown_or_idle" };
  }
}

export class CodexRuntimePresenceProbe implements RuntimePresenceProbe {
  constructor(
    private readonly killFn: (pid: number, signal: number) => void = (pid, signal) => process.kill(pid, signal),
    private readonly sessionFileReader?: (sessionId: string) => Promise<CodexSessionLookupResult>,
  ) {}

  supports(target: TerminalActivationTarget): boolean {
    return target.runtimeKind === "codex" && Number.isInteger(target.runtimePid);
  }

  async check(target: TerminalActivationTarget): Promise<RuntimePresenceStatus> {
    if (!Number.isInteger(target.runtimePid)) {
      return "unknown";
    }
    try {
      this.killFn(target.runtimePid!, 0);
      if (!target.runtimeSessionId) {
        return "unknown";
      }
      const sessionInfo = await (this.sessionFileReader ?? defaultCodexSessionFileReader)(target.runtimeSessionId);
      if (sessionInfo === "unknown") {
        return "unknown";
      }
      if (!sessionInfo || sessionInfo.sessionId !== target.runtimeSessionId) {
        return "gone";
      }
      return "alive";
    } catch (error) {
      const code = error instanceof Error && "code" in error ? String((error as NodeJS.ErrnoException).code ?? "") : "";
      if (code === "ESRCH") {
        return "gone";
      }
      return "unknown";
    }
  }
}

export class CodexTerminalStateProbe implements TerminalStateProbe {
  constructor(
    private readonly iTermProbe: TerminalStateProbe = new Iterm2TerminalStateProbe(),
    private readonly tmuxProbe: TerminalStateProbe = new TmuxTerminalStateProbe(),
    private readonly sessionFileReader?: (sessionId: string) => Promise<CodexSessionLookupResult>,
    private readonly statReader?: (filePath: string) => Promise<{ mtimeMs: number } | null>,
    private readonly nowFn: () => number = () => Date.now(),
  ) {}

  supports(target: TerminalActivationTarget): boolean {
    return target.runtimeKind === "codex";
  }

  async check(target: TerminalActivationTarget): Promise<{
    presence: TerminalPresenceStatus;
    busy: TerminalBusyStatus;
  }> {
    const terminalState = await this.readTerminalState(target);
    if (!target.runtimeSessionId) {
      return terminalState;
    }
    const sessionInfo = await (this.sessionFileReader ?? defaultCodexSessionFileReader)(target.runtimeSessionId);
    if (sessionInfo === "unknown" || !sessionInfo || sessionInfo.sessionId !== target.runtimeSessionId) {
      return terminalState;
    }
    const stat = await (this.statReader ?? defaultFileStatReader)(sessionInfo.filePath);
    if (!stat) {
      return terminalState;
    }
    if (terminalState.busy === "busy" || terminalState.presence === "gone") {
      return terminalState;
    }
    const ageMs = this.nowFn() - stat.mtimeMs;
    if (ageMs < 5000) {
      return { presence: terminalState.presence, busy: "busy" };
    }
    if (ageMs < 30000) {
      return { presence: terminalState.presence, busy: "idle" };
    }
    return terminalState;
  }

  private async readTerminalState(target: TerminalActivationTarget): Promise<{
    presence: TerminalPresenceStatus;
    busy: TerminalBusyStatus;
  }> {
    if (this.iTermProbe.supports(target)) {
      return this.iTermProbe.check(target);
    }
    if (this.tmuxProbe.supports(target)) {
      return this.tmuxProbe.check(target);
    }
    return { presence: "unknown", busy: "unknown" };
  }
}

export class Iterm2TerminalStateProbe implements TerminalStateProbe {
  constructor(
    private readonly execAsync: ExecFileAsyncLike = execFileAsync,
    private readonly options: {
      iterm2ApiPath?: string;
      sampleDelayMs?: number;
      sleep?: (ms: number) => Promise<void>;
    } = {},
  ) {}

  supports(target: TerminalActivationTarget): boolean {
    // Only support iTerm2 targets that are NOT Claude Code
    // Claude Code targets are handled by ClaudeCodeTerminalStateProbe
    return (
      target.backend === "iterm2" &&
      target.runtimeKind !== "claude_code" &&
      typeof target.itermSessionId === "string" &&
      target.itermSessionId.length > 0
    );
  }

  async check(target: TerminalActivationTarget): Promise<{
    presence: TerminalPresenceStatus;
    busy: TerminalBusyStatus;
  }> {
    const sessionId = target.itermSessionId?.trim();
    if (!sessionId) {
      return { presence: "unknown", busy: "unknown" };
    }

    let it2api: string;
    try {
      it2api = resolveIterm2ApiPath(this.options.iterm2ApiPath);
    } catch {
      return { presence: "unknown", busy: "unknown" };
    }

    const presence = await this.checkSessionPresence(it2api, sessionId);
    if (presence !== "available") {
      return { presence, busy: "unknown" };
    }

    await this.tryReadPrompt(it2api, sessionId);
    const first = await this.readBufferTail(it2api, sessionId);
    if (!first) {
      return { presence: "available", busy: "unknown" };
    }
    await (this.options.sleep ?? sleep)(this.options.sampleDelayMs ?? DEFAULT_ITERM2_SAMPLE_DELAY_MS);
    const second = await this.readBufferTail(it2api, sessionId);
    if (!second) {
      return { presence: "available", busy: "unknown" };
    }

    if (first !== second) {
      return { presence: "available", busy: "busy" };
    }
    if (containsActiveBufferMarker(second)) {
      return { presence: "available", busy: "busy" };
    }
    if (hasVisibleTypingPrompt(second)) {
      return { presence: "available", busy: "busy" };
    }
    return { presence: "available", busy: "unknown" };
  }

  private async checkSessionPresence(it2api: string, sessionId: string): Promise<TerminalPresenceStatus> {
    try {
      const result = await this.execAsync(it2api, ["list-sessions"]);
      const sessionIds = parseIterm2SessionIds(result.stdout);
      return sessionIds.includes(sessionId) ? "available" : "gone";
    } catch {
      return "unknown";
    }
  }

  private async tryReadPrompt(it2api: string, sessionId: string): Promise<void> {
    try {
      await this.execAsync(it2api, ["get-prompt", sessionId]);
    } catch {
      return;
    }
  }

  private async readBufferTail(it2api: string, sessionId: string): Promise<string | null> {
    try {
      const result = await this.execAsync(it2api, ["get-buffer", sessionId]);
      return normalizeBufferTail(result.stdout);
    } catch {
      return null;
    }
  }
}

export class TmuxTerminalStateProbe implements TerminalStateProbe {
  constructor(
    private readonly execAsync: ExecFileAsyncLike = execFileAsync,
    private readonly options: {
      sampleDelayMs?: number;
      sleep?: (ms: number) => Promise<void>;
    } = {},
  ) {}

  supports(target: TerminalActivationTarget): boolean {
    return target.backend === "tmux" && typeof target.tmuxPaneId === "string" && target.tmuxPaneId.trim().length > 0;
  }

  async check(target: TerminalActivationTarget): Promise<{
    presence: TerminalPresenceStatus;
    busy: TerminalBusyStatus;
  }> {
    const paneId = target.tmuxPaneId?.trim();
    if (!paneId) {
      return { presence: "unknown", busy: "unknown" };
    }

    const paneState = await this.readPaneState(paneId);
    if (paneState === "missing") {
      return { presence: "gone", busy: "unknown" };
    }
    if (paneState === "unknown") {
      return { presence: "unknown", busy: "unknown" };
    }
    if (paneState.dead) {
      return { presence: "gone", busy: "unknown" };
    }

    const first = await this.readBufferTail(paneId);
    if (!first) {
      return { presence: "available", busy: "unknown" };
    }
    await (this.options.sleep ?? sleep)(this.options.sampleDelayMs ?? DEFAULT_TMUX_SAMPLE_DELAY_MS);
    const second = await this.readBufferTail(paneId);
    if (!second) {
      return { presence: "available", busy: "unknown" };
    }

    if (first !== second) {
      return { presence: "available", busy: "busy" };
    }
    if (containsActiveBufferMarker(second)) {
      return { presence: "available", busy: "busy" };
    }
    const cursorHint = evaluateCursorAwareTypingPrompt(target, paneState, second);
    if (cursorHint === "busy") {
      return { presence: "available", busy: "busy" };
    }
    if (
      cursorHint === "unknown" &&
      paneState.active &&
      hasVisibleTypingPrompt(second, typingPromptPrefixesForRuntime(target.runtimeKind))
    ) {
      return { presence: "available", busy: "busy" };
    }
    return { presence: "available", busy: "unknown" };
  }

  private async readPaneState(paneId: string): Promise<{
    active: boolean;
    dead: boolean;
    cursorX: number | null;
    cursorY: number | null;
    height: number | null;
  } | "missing" | "unknown"> {
    try {
      const result = await this.execAsync("tmux", [
        "display-message",
        "-p",
        "-t",
        paneId,
        "#{pane_active} #{pane_dead} #{cursor_x} #{cursor_y} #{pane_height}",
      ]);
      const [active, dead, cursorX, cursorY, height] = result.stdout.trim().split(/\s+/, 5);
      if (!active || !dead) {
        return "unknown";
      }
      return {
        active: active === "1",
        dead: dead === "1",
        cursorX: parseOptionalInt(cursorX),
        cursorY: parseOptionalInt(cursorY),
        height: parseOptionalInt(height),
      };
    } catch (error) {
      if (isTmuxMissingPaneError(error)) {
        return "missing";
      }
      return "unknown";
    }
  }

  private async readBufferTail(paneId: string): Promise<string | null> {
    try {
      const result = await this.execAsync("tmux", ["capture-pane", "-p", "-t", paneId, "-S", "-20"]);
      return normalizeBufferTail(result.stdout);
    } catch {
      return null;
    }
  }
}

function containsActiveBufferMarker(bufferTail: string): boolean {
  return ACTIVE_BUFFER_MARKERS.some((marker) => bufferTail.includes(marker));
}

function hasVisibleTypingPrompt(bufferTail: string, prefixes: readonly string[] = TYPING_PROMPT_PREFIXES): boolean {
  const lines = bufferTail
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
  const lastLine = lines.at(-1);
  if (!lastLine) {
    return false;
  }
  for (const prefix of prefixes) {
    if (lastLine.startsWith(prefix) && lastLine.slice(prefix.length).trim().length > 0) {
      return true;
    }
  }
  return false;
}

function evaluateCursorAwareTypingPrompt(
  target: TerminalActivationTarget,
  paneState: { cursorX: number | null; cursorY: number | null; height: number | null },
  bufferTail: string,
): "busy" | "not_busy" | "unknown" {
  const prefix = runtimeTypingPromptPrefix(target.runtimeKind);
  if (!prefix) {
    return "unknown";
  }
  if (paneState.cursorX == null || paneState.cursorY == null || paneState.height == null) {
    return "unknown";
  }

  const lines = bufferTail
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trimEnd());
  if (lines.length === 0) {
    return "unknown";
  }

  const captureStartRow = Math.max(0, paneState.height - lines.length);
  const lineIndex = paneState.cursorY - captureStartRow;
  if (lineIndex < 0 || lineIndex >= lines.length) {
    return "unknown";
  }

  const line = lines[lineIndex] ?? "";
  if (!line.startsWith(prefix)) {
    return "not_busy";
  }
  return paneState.cursorX > prefix.length ? "busy" : "not_busy";
}

function runtimeTypingPromptPrefix(runtimeKind: TerminalActivationTarget["runtimeKind"]): string | null {
  if (runtimeKind === "codex") {
    return "› ";
  }
  if (runtimeKind === "claude_code") {
    return "❯ ";
  }
  return null;
}

function typingPromptPrefixesForRuntime(runtimeKind: TerminalActivationTarget["runtimeKind"]): readonly string[] {
  if (runtimeKind === "codex") {
    return ["› "];
  }
  if (runtimeKind === "claude_code") {
    return ["❯ ", "› "];
  }
  return TYPING_PROMPT_PREFIXES;
}

function parseOptionalInt(value: string | undefined): number | null {
  if (!value) {
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeBufferTail(buffer: string): string | null {
  const normalized = buffer
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trimEnd())
    .slice(-20)
    .join("\n")
    .trim();
  return normalized.length > 0 ? normalized : null;
}

function resolveIterm2ApiPath(override?: string): string {
  if (override) {
    return override;
  }
  const candidates = [
    "/Applications/iTerm.app/Contents/Resources/it2api",
    "/Applications/iTerm.app/Contents/Resources/utilities/it2api",
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error("unable to locate iTerm2 it2api helper");
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function defaultFileStatReader(filePath: string): Promise<{ mtimeMs: number } | null> {
  try {
    const stats = await fs.promises.stat(filePath);
    return { mtimeMs: stats.mtimeMs };
  } catch {
    return null;
  }
}

type CodexSessionInfo = {
  sessionId: string;
  filePath: string;
  cwd?: string | null;
};

type CodexSessionLookupResult = CodexSessionInfo | null | "unknown";

async function defaultCodexSessionFileReader(sessionId: string): Promise<CodexSessionLookupResult> {
  const sessionsRoot = path.join(os.homedir(), ".codex", "sessions");
  const filePath = await findCodexSessionFile(sessionsRoot, sessionId).catch(() => "unknown" as const);
  if (filePath === "unknown") {
    return "unknown";
  }
  if (!filePath) {
    return null;
  }
  try {
    const firstLine = await readFirstLine(filePath);
    if (!firstLine) {
      return "unknown";
    }
    const record = JSON.parse(firstLine) as {
      type?: string;
      payload?: { id?: unknown; cwd?: unknown };
    };
    const parsedSessionId = typeof record.payload?.id === "string" ? record.payload.id : null;
    if (record.type !== "session_meta" || parsedSessionId !== sessionId) {
      return "unknown";
    }
    return {
      sessionId: parsedSessionId,
      filePath,
      cwd: typeof record.payload?.cwd === "string" ? record.payload.cwd : null,
    };
  } catch {
    return "unknown";
  }
}

async function findCodexSessionFile(root: string, sessionId: string): Promise<string | null> {
  let years: fs.Dirent[];
  try {
    years = await fs.promises.readdir(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const year of years) {
    if (!year.isDirectory()) {
      continue;
    }
    const yearPath = path.join(root, year.name);
    const match = await walkCodexSessionLevel(yearPath, sessionId, 2);
    if (match) {
      return match;
    }
  }
  return null;
}

async function walkCodexSessionLevel(dir: string, sessionId: string, depth: number): Promise<string | null> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isFile() && entry.name.endsWith(`${sessionId}.jsonl`)) {
      return entryPath;
    }
    if (entry.isDirectory() && depth > 0) {
      const match = await walkCodexSessionLevel(entryPath, sessionId, depth - 1);
      if (match) {
        return match;
      }
    }
  }
  return null;
}

export async function readFirstLine(filePath: string): Promise<string | null> {
  const handle = await fs.promises.open(filePath, "r");
  try {
    const chunkSize = 4096;
    const chunks: string[] = [];
    let position = 0;

    while (true) {
      const buffer = Buffer.alloc(chunkSize);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead <= 0) {
        break;
      }
      const chunk = buffer.toString("utf8", 0, bytesRead);
      const newline = chunk.indexOf("\n");
      if (newline >= 0) {
        chunks.push(chunk.slice(0, newline));
        break;
      }
      chunks.push(chunk);
      position += bytesRead;
    }

    const firstLine = chunks.join("").trim();
    return firstLine.length > 0 ? firstLine : null;
  } finally {
    await handle.close();
  }
}

function isTmuxMissingPaneError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const candidate = `${error.message} ${"stderr" in error ? String((error as { stderr?: unknown }).stderr ?? "") : ""}`;
  return candidate.includes("can't find pane");
}

export class ClaudeCodeRuntimePresenceProbe implements RuntimePresenceProbe {
  constructor(
    private readonly killFn: (pid: number, signal: number) => void = (pid, signal) => process.kill(pid, signal),
    private readonly sessionFileReader?: (pid: number) => Promise<{ sessionId: string; cwd: string } | null>,
  ) {}

  supports(target: TerminalActivationTarget): boolean {
    return target.runtimeKind === "claude_code" && Number.isInteger(target.runtimePid);
  }

  async check(target: TerminalActivationTarget): Promise<RuntimePresenceStatus> {
    if (!Number.isInteger(target.runtimePid)) {
      return "unknown";
    }

    try {
      // 1. Check if process exists
      this.killFn(target.runtimePid!, 0);

      // 2. Verify session file exists and is valid
      const sessionInfo = await (this.sessionFileReader ?? this.defaultSessionFileReader)(target.runtimePid!);
      if (!sessionInfo) {
        return "gone"; // Process exists but session file is invalid/missing
      }

      // 3. Verify session ID matches (prevent PID reuse)
      if (target.runtimeSessionId && sessionInfo.sessionId !== target.runtimeSessionId) {
        return "gone";
      }

      return "alive";
    } catch (error) {
      const code = error instanceof Error && "code" in error ? String((error as NodeJS.ErrnoException).code ?? "") : "";
      if (code === "ESRCH") {
        return "gone"; // Process doesn't exist
      }
      return "unknown";
    }
  }

  private readonly defaultSessionFileReader = async (pid: number): Promise<{
    sessionId: string;
    cwd: string;
  } | null> => {
    const sessionFile = path.join(os.homedir(), ".claude", "sessions", `${pid}.json`);
    try {
      const content = await fs.promises.readFile(sessionFile, "utf8");
      const session = JSON.parse(content);

      if (!session.sessionId || typeof session.sessionId !== "string") {
        return null;
      }

      return {
        sessionId: session.sessionId,
        cwd: session.cwd,
      };
    } catch {
      return null;
    }
  };
}

export class ClaudeCodeTerminalStateProbe implements TerminalStateProbe {
  constructor(
    private readonly sessionFileReader?: (pid: number) => Promise<{ sessionId: string; cwd: string } | null>,
    private readonly logFileStatReader?: (path: string) => Promise<{ mtimeMs: number } | null>,
    private readonly sleepFn: (ms: number) => Promise<void> = sleep,
  ) {}

  supports(target: TerminalActivationTarget): boolean {
    return target.runtimeKind === "claude_code";
  }

  async check(target: TerminalActivationTarget): Promise<{
    presence: TerminalPresenceStatus;
    busy: TerminalBusyStatus;
  }> {
    if (!target.runtimePid || !target.runtimeSessionId) {
      return { presence: "unknown", busy: "unknown" };
    }

    try {
      // 1. Read session file to get cwd
      const sessionData = await (this.sessionFileReader ?? this.defaultSessionFileReader)(target.runtimePid);
      if (!sessionData) {
        return { presence: "gone", busy: "unknown" };
      }

      // 2. Verify session ID matches
      if (sessionData.sessionId !== target.runtimeSessionId) {
        return { presence: "gone", busy: "unknown" };
      }

      // 3. Construct log file path using Claude Code's encoding rules
      const sanitizedProjectPath = sessionData.cwd.replace(/[^a-zA-Z0-9]/g, '-');
      const logFile = path.join(os.homedir(), ".claude", "projects", sanitizedProjectPath, `${target.runtimeSessionId}.jsonl`);

      // 4. Check log file activity
      const busy = await this.checkLogFileActivity(logFile);

      // 5. Check iTerm2 session presence if available
      const presence = target.backend === "iterm2" && target.itermSessionId
        ? await this.checkIterm2Presence(target.itermSessionId)
        : "available";

      return { presence, busy };

    } catch (error) {
      console.warn('Claude Code state check failed:', error);
      return { presence: "unknown", busy: "unknown" };
    }
  }

  private readonly defaultSessionFileReader = async (pid: number): Promise<{
    sessionId: string;
    cwd: string;
  } | null> => {
    const sessionFile = path.join(os.homedir(), ".claude", "sessions", `${pid}.json`);
    try {
      const content = await fs.promises.readFile(sessionFile, "utf8");
      const session = JSON.parse(content);

      if (!session.sessionId || typeof session.sessionId !== "string") {
        return null;
      }

      return {
        sessionId: session.sessionId,
        cwd: session.cwd,
      };
    } catch {
      return null;
    }
  };

  private readonly defaultLogFileStatReader = async (filePath: string): Promise<{ mtimeMs: number } | null> => {
    try {
      const stats = await fs.promises.stat(filePath);
      return { mtimeMs: stats.mtimeMs };
    } catch {
      return null;
    }
  };

  private async checkLogFileActivity(logFile: string): Promise<TerminalBusyStatus> {
    try {
      const statResult = await (this.logFileStatReader ?? this.defaultLogFileStatReader)(logFile);
      if (!statResult) {
        return "unknown";
      }

      const timeSinceLastActivity = Date.now() - statResult.mtimeMs;

      // Activity within last 5 seconds = busy
      if (timeSinceLastActivity < 5000) {
        return "busy";
      }

      // Secondary sampling to confirm (avoid false positives)
      await this.sleepFn(250);
      const statResult2 = await (this.logFileStatReader ?? this.defaultLogFileStatReader)(logFile);
      if (!statResult2) {
        return "unknown";
      }

      const timeSinceLastActivity2 = Date.now() - statResult2.mtimeMs;

      if (statResult2.mtimeMs > statResult.mtimeMs && timeSinceLastActivity2 < 5000) {
        return "busy";
      }

      // Activity within last 30 seconds = idle but recently active
      return timeSinceLastActivity2 < 30000 ? "idle" : "unknown";

    } catch {
      return "unknown";
    }
  }

  private async checkIterm2Presence(itermSessionId: string): Promise<TerminalPresenceStatus> {
    try {
      const it2api = resolveIterm2ApiPath();
      const result = await execFileAsync(it2api, ["list-sessions"]);
      const sessionIds = parseIterm2SessionIds(result.stdout);
      return sessionIds.includes(itermSessionId) ? "available" : "gone";
    } catch {
      return "unknown";
    }
  }
}

function parseIterm2SessionIds(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const match = line.match(/\bid=([A-F0-9-]+)/i);
      return match ? match[1] : null;
    })
    .filter((id): id is string => id !== null);
}
