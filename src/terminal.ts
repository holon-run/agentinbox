import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import crypto from "node:crypto";
import { RuntimeKind, TerminalBackend, TerminalTarget } from "./model";

const execFileAsync = promisify(execFile);

export interface DetectedTerminalContext {
  runtimeKind: RuntimeKind;
  runtimeSessionId?: string | null;
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
  newItemCount: number;
  summary?: string | null;
}): string {
  const base = `AgentInbox: ${input.newItemCount} new items arrived in inbox ${input.inboxId}.`;
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
  async dispatch(target: TerminalTarget, prompt: string): Promise<void> {
    if (target.backend === "tmux") {
      if (!target.tmuxPaneId) {
        throw new Error(`tmux terminal target ${target.targetId} is missing tmuxPaneId`);
      }
      await execFileAsync("tmux", ["send-keys", "-t", target.tmuxPaneId, prompt, "Enter"]);
      return;
    }

    if (target.backend === "iterm2") {
      await dispatchToIterm2(target, prompt);
      return;
    }

    throw new Error(`unsupported terminal backend: ${String(target.backend)}`);
  }
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
} {
  const codexThreadId = normalizeOptionalString(env.CODEX_THREAD_ID);
  if (codexThreadId) {
    return {
      runtimeKind: "codex",
      runtimeSessionId: codexThreadId,
    };
  }

  const claudeSessionId = normalizeOptionalString(
    env.CLAUDE_CODE_SESSION_ID
      ?? env.CLAUDECODE_SESSION_ID
      ?? env.CLAUDE_SESSION_ID,
  );
  if (claudeSessionId) {
    return {
      runtimeKind: "claude_code",
      runtimeSessionId: claudeSessionId,
    };
  }

  return {
    runtimeKind: "unknown",
    runtimeSessionId: null,
  };
}

function normalizeOptionalString(value: string | undefined | null): string | null {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

async function dispatchToIterm2(target: TerminalTarget, prompt: string): Promise<void> {
  const script = `
set targetTty to system attribute "TARGET_TTY"
set targetSessionId to system attribute "TARGET_SESSION_ID"
set promptText to system attribute "AGENT_PROMPT"
tell application "iTerm2"
  repeat with aWindow in windows
    repeat with aTab in tabs of aWindow
      repeat with aSession in sessions of aTab
        tell aSession
          if ((targetTty is not "" and (tty as text) is equal to targetTty) or (targetSessionId is not "" and (unique ID as text) is equal to targetSessionId)) then
            write text promptText
            return "sent"
          end if
        end tell
      end repeat
    end repeat
  end repeat
end tell
return "not-found"
`;

  const { stdout } = await execFileAsync("osascript", ["-e", script], {
    env: {
      ...process.env,
      TARGET_TTY: target.tty ?? "",
      TARGET_SESSION_ID: target.itermSessionId ?? "",
      AGENT_PROMPT: prompt,
    },
  });

  if (!stdout.includes("sent")) {
    throw new Error(`unable to find iTerm2 session for terminal target ${target.targetId}`);
  }
}
