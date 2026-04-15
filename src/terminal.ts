import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RuntimeKind, TerminalActivationTarget, TerminalBackend } from "./model";

const execFileAsync = promisify(execFile);
type ExecFileAsyncLike = (
  file: string,
  args: readonly string[],
  options?: {
    env?: NodeJS.ProcessEnv;
  },
) => Promise<{ stdout: string; stderr: string }>;

export type TerminalProbeStatus = "available" | "gone" | "unknown";

export interface DetectedTerminalContext {
  runtimeKind: RuntimeKind;
  runtimeSessionId?: string | null;
  runtimePid?: number | null;
  backend: TerminalBackend;
  tmuxPaneId?: string | null;
  tty?: string | null;
  termProgram?: string | null;
  itermSessionId?: string | null;
}

export function detectTerminalContext(env: NodeJS.ProcessEnv = process.env): DetectedTerminalContext {
  const tmuxPaneId = normalizeOptionalString(env.TMUX_PANE);
  const termProgram = normalizeOptionalString(env.TERM_PROGRAM);
  const tty = detectTty(env);
  const itermSessionId = normalizeItermSessionId(env.ITERM_SESSION_ID ?? env.TERM_SESSION_ID);
  const runtime = detectRuntimeContext(env);

  if (tmuxPaneId) {
    return {
      runtimeKind: runtime.runtimeKind,
      runtimeSessionId: runtime.runtimeSessionId,
      runtimePid: runtime.runtimePid,
      backend: "tmux",
      tmuxPaneId,
      tty,
      termProgram,
      itermSessionId,
    };
  }

  if (itermSessionId || termProgram === "iTerm.app") {
    return {
      runtimeKind: runtime.runtimeKind,
      runtimeSessionId: runtime.runtimeSessionId,
      runtimePid: runtime.runtimePid,
      backend: "iterm2",
      tty,
      termProgram,
      itermSessionId,
    };
  }

  throw new Error("unable to detect a supported terminal context");
}

export function renderAgentPrompt(input: {
  inboxId: string;
  totalUnackedCount: number;
  summary?: string | null;
}): string {
  const itemWord = input.totalUnackedCount === 1 ? "item" : "items";
  const base = `AgentInbox: ${input.totalUnackedCount} unacked ${itemWord} in inbox ${input.inboxId}.`;
  if (input.summary) {
    return `${base} Summary: ${input.summary}. Please read the inbox, process them, and ack when finished.`;
  }
  return `${base} Please read the inbox, process them, and ack when finished.`;
}

export function assignedAgentIdFromContext(input: {
  runtimeKind?: RuntimeKind | null;
  runtimeSessionId?: string | null;
  backend: TerminalBackend;
  tmuxPaneId?: string | null;
  itermSessionId?: string | null;
  tty?: string | null;
}): string {
  const primary = normalizeOptionalString(input.runtimeSessionId)
    ?? normalizeOptionalString(input.tmuxPaneId)
    ?? normalizeOptionalString(input.itermSessionId)
    ?? normalizeOptionalString(input.tty);
  if (!primary) {
    throw new Error("unable to derive agentId from terminal context");
  }
  const normalized = primary.replace(/[^a-zA-Z0-9]+/g, "").toLowerCase();
  if (normalized.length > 0) {
    return `agent_${input.runtimeKind ?? "unknown"}_${normalized.slice(0, 40)}`;
  }
  const digest = crypto.createHash("sha256").update(primary).digest("hex").slice(0, 16);
  return `agent_${input.runtimeKind ?? "unknown"}_${digest}`;
}

export class TerminalDispatcher {
  constructor(
    private readonly execAsync: ExecFileAsyncLike = execFileAsync,
    private readonly options: {
      iterm2ApiPath?: string;
    } = {},
  ) {}

  async dispatch(target: TerminalActivationTarget, prompt: string): Promise<void> {
    if (target.backend === "tmux") {
      if (!target.tmuxPaneId) {
        throw new Error(`tmux terminal target ${target.targetId} is missing tmuxPaneId`);
      }
      await this.execAsync("tmux", ["send-keys", "-t", target.tmuxPaneId, "-l", prompt]);
      await this.execAsync("tmux", ["send-keys", "-t", target.tmuxPaneId, "-l", "\r"]);
      return;
    }

    if (target.backend === "iterm2") {
      await dispatchToIterm2(target, prompt, this.execAsync, this.options.iterm2ApiPath);
      return;
    }

    throw new Error(`unsupported terminal backend: ${String(target.backend)}`);
  }

  async probe(target: TerminalActivationTarget): Promise<boolean> {
    return (await this.probeStatus(target)) === "available";
  }

  async probeStatus(target: TerminalActivationTarget): Promise<TerminalProbeStatus> {
    try {
      if (target.backend === "tmux") {
        if (!target.tmuxPaneId) {
          return "unknown";
        }
        const result = await this.execAsync("tmux", ["display-message", "-p", "-t", target.tmuxPaneId, "#{pane_id}"]);
        return result.stdout.trim() === target.tmuxPaneId ? "available" : "gone";
      }
      if (target.backend === "iterm2") {
        const sessionId = normalizeOptionalString(target.itermSessionId);
        if (!sessionId) {
          return "unknown";
        }
        const it2api = resolveIterm2ApiPath(this.options.iterm2ApiPath);
        const result = await this.execAsync(it2api, ["list-sessions"]);
        return result.stdout.includes(sessionId) ? "available" : "gone";
      }
    } catch (error) {
      if (target.backend === "tmux" && isTmuxMissingPaneError(error)) {
        return "gone";
      }
      return "unknown";
    }
    return "unknown";
  }
}

function isTmuxMissingPaneError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const candidate = `${error.message} ${"stderr" in error ? String((error as { stderr?: unknown }).stderr ?? "") : ""}`;
  return candidate.includes("can't find pane");
}

function detectTty(env: NodeJS.ProcessEnv): string | null {
  const direct = tryReadCurrentTty();
  if (direct) {
    return direct;
  }
  const parent = tryReadParentTty(env.PPID);
  return parent;
}

function tryReadCurrentTty(): string | null {
  try {
    const tty = execFileSync("tty", [], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (!tty || tty === "not a tty") {
      return null;
    }
    return tty;
  } catch {
    return null;
  }
}

function tryReadParentTty(ppid: string | undefined): string | null {
  if (!ppid) {
    return null;
  }
  try {
    const tty = execFileSync("ps", ["-o", "tty=", "-p", ppid], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (!tty || tty === "??") {
      return null;
    }
    return tty.startsWith("/dev/") ? tty : `/dev/${tty}`;
  } catch {
    return null;
  }
}

function normalizeItermSessionId(raw: string | undefined): string | null {
  const value = normalizeOptionalString(raw);
  if (!value) {
    return null;
  }
  const parts = value.split(":");
  return parts[parts.length - 1] || null;
}

function detectRuntimeContext(env: NodeJS.ProcessEnv): {
  runtimeKind: RuntimeKind;
  runtimeSessionId: string | null;
  runtimePid: number | null;
} {
  const codexThreadId = normalizeOptionalString(env.CODEX_THREAD_ID);
  if (codexThreadId) {
    return {
      runtimeKind: "codex",
      runtimeSessionId: codexThreadId,
      runtimePid: findNamedProcessInAncestry((name) => name === "codex"),
    };
  }

  const claudeSessionId = normalizeOptionalString(
    env.CLAUDE_CODE_SESSION_ID
      ?? env.CLAUDECODE_SESSION_ID
      ?? env.CLAUDE_SESSION_ID,
  );
  if (claudeSessionId) {
    const claudePid = findNamedProcessInAncestry((name) => name.includes("claude"));
    return {
      runtimeKind: "claude_code",
      runtimeSessionId: claudeSessionId,
      runtimePid: claudePid,
    };
  }

  // Fallback: try to detect Claude Code from filesystem
  const claudeCodeFromFs = detectClaudeCodeFromFileSystem(env);
  if (claudeCodeFromFs) {
    return claudeCodeFromFs;
  }

  return {
    runtimeKind: "unknown",
    runtimeSessionId: null,
    runtimePid: null,
  };
}

function detectClaudeCodeFromFileSystem(env: NodeJS.ProcessEnv): {
  runtimeKind: RuntimeKind;
  runtimeSessionId: string | null;
  runtimePid: number | null;
} | null {
  try {
    // Walk up the process tree to find a claude process
    const claudePid = findNamedProcessInAncestry((name) => name.includes("claude"));
    if (!claudePid) {
      return null;
    }

    // Read Claude Code session file
    const sessionFile = path.join(os.homedir(), ".claude", "sessions", `${String(claudePid)}.json`);
    if (!fs.existsSync(sessionFile)) {
      return null;
    }

    const sessionContent = fs.readFileSync(sessionFile, "utf8");
    const sessionData = JSON.parse(sessionContent);

    // Validate session data structure
    if (!sessionData.sessionId || typeof sessionData.sessionId !== "string") {
      return null;
    }

    // Verify this session matches current working directory
    // This helps avoid picking up wrong claude sessions
    if (sessionData.cwd) {
      const currentProject = path.basename(process.cwd());
      const sessionProject = path.basename(sessionData.cwd);
      if (currentProject !== sessionProject) {
        return null;
      }
    }

    return {
      runtimeKind: "claude_code",
      runtimeSessionId: sessionData.sessionId,
      runtimePid: claudePid,
    };
  } catch {
    // Silently fail if filesystem detection fails
    return null;
  }
}

function findNamedProcessInAncestry(matcher: (processName: string) => boolean): number | null {
  let currentPid = process.ppid;
  const maxIterations = 10; // Prevent infinite loops
  let iterations = 0;

  while (currentPid && iterations < maxIterations) {
    const processName = tryGetProcessName(currentPid);
    if (processName && matcher(processName)) {
      return currentPid;
    }

    // Get parent of current process
    const parentPid = tryGetParentPid(currentPid);
    if (!parentPid) {
      break;
    }
    currentPid = parentPid;
    iterations++;
  }

  return null;
}

function tryGetParentPid(pid: number): number | null {
  try {
    const output = execFileSync("ps", ["-p", String(pid), "-o", "ppid="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const ppid = parseInt(output.trim(), 10);
    return isNaN(ppid) || ppid === 0 ? null : ppid;
  } catch {
    return null;
  }
}

function tryGetProcessName(pid: number): string | null {
  try {
    const output = execFileSync("ps", ["-p", String(pid), "-o", "comm="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return output.trim();
  } catch {
    return null;
  }
}

function normalizeOptionalString(value: string | undefined | null): string | null {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

async function dispatchToIterm2(
  target: TerminalActivationTarget,
  prompt: string,
  execAsync: ExecFileAsyncLike,
  iterm2ApiPath?: string,
): Promise<void> {
  const sessionId = normalizeOptionalString(target.itermSessionId);
  if (!sessionId) {
    throw new Error(`iTerm2 terminal target ${target.targetId} is missing itermSessionId`);
  }

  const it2api = resolveIterm2ApiPath(iterm2ApiPath);
  await execAsync(it2api, ["send-text", sessionId, prompt]);
  // Background Codex/Claude sessions only submit reliably when Return is sent
  // in a second call rather than concatenated to the original prompt payload.
  await execAsync(it2api, ["send-text", sessionId, "\r"]);
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
