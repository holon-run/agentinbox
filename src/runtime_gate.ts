import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { TerminalActivationTarget } from "./model";

const execFileAsync = promisify(execFile);
const DEFAULT_ITERM2_SAMPLE_DELAY_MS = 250;
const ACTIVE_BUFFER_MARKERS = [
  "esc to interrupt",
  "Working (",
  "⠼ ",
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
      new Iterm2TerminalStateProbe(),
      new ClaudeCodeTerminalStateProbe(),
    ],
  ) {}

  async evaluate(target: TerminalActivationTarget): Promise<{
    outcome: "inject" | "defer" | "offline";
    reason: string;
  }> {
    const runtimeProbe = this.runtimeProbes.find((probe) => probe.supports(target));
    const runtimePresence = runtimeProbe ? await runtimeProbe.check(target) : "unknown";
    const terminalProbe = this.terminalProbes.find((probe) => probe.supports(target));
    const terminalState = terminalProbe
      ? await terminalProbe.check(target)
      : { presence: "unknown" as const, busy: "unknown" as const };

    if (runtimePresence === "gone") {
      return { outcome: "offline", reason: "runtime_gone" };
    }
    if (terminalState.presence === "gone") {
      return { outcome: "offline", reason: "terminal_gone" };
    }
    if (terminalState.busy === "busy") {
      return { outcome: "defer", reason: "terminal_busy" };
    }
    return { outcome: "inject", reason: "gate_unknown_or_idle" };
  }
}

export class CodexRuntimePresenceProbe implements RuntimePresenceProbe {
  constructor(
    private readonly killFn: (pid: number, signal: number) => void = (pid, signal) => process.kill(pid, signal),
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
    return target.backend === "iterm2" && typeof target.itermSessionId === "string" && target.itermSessionId.length > 0;
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
    return { presence: "available", busy: "unknown" };
  }

  private async checkSessionPresence(it2api: string, sessionId: string): Promise<TerminalPresenceStatus> {
    try {
      const result = await this.execAsync(it2api, ["list-sessions"]);
      const sessions = result.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      return sessions.includes(sessionId) ? "available" : "gone";
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

function containsActiveBufferMarker(bufferTail: string): boolean {
  return ACTIVE_BUFFER_MARKERS.some((marker) => bufferTail.includes(marker));
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

export class ClaudeCodeRuntimePresenceProbe implements RuntimePresenceProbe {
  constructor(
    private readonly killFn: (pid: number, signal: number) => void = (pid, signal) => process.kill(pid, signal),
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
      const sessionInfo = await this.findSessionByPid(target.runtimePid!);
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

  private async findSessionByPid(pid: number): Promise<{
    sessionId: string;
    cwd: string;
  } | null> {
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
  }
}

export class ClaudeCodeTerminalStateProbe implements TerminalStateProbe {
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
      const sessionFile = path.join(os.homedir(), ".claude", "sessions", `${target.runtimePid}.json`);
      const sessionContent = await fs.promises.readFile(sessionFile, "utf8");
      const sessionData = JSON.parse(sessionContent);

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

  private async checkLogFileActivity(logFile: string): Promise<TerminalBusyStatus> {
    try {
      const stats = await fs.promises.stat(logFile);
      const timeSinceLastActivity = Date.now() - stats.mtimeMs;

      // Activity within last 5 seconds = busy
      if (timeSinceLastActivity < 5000) {
        return "busy";
      }

      // Secondary sampling to confirm (avoid false positives)
      await sleep(250);
      const stats2 = await fs.promises.stat(logFile);
      const timeSinceLastActivity2 = Date.now() - stats2.mtimeMs;

      if (stats2.mtimeMs > stats.mtimeMs && timeSinceLastActivity2 < 5000) {
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
      const sessions = result.stdout.split(/\r?\n/).map((line: string) => line.trim()).filter((line: string) => line.length > 0);
      return sessions.includes(itermSessionId) ? "available" : "gone";
    } catch {
      return "unknown";
    }
  }
}
