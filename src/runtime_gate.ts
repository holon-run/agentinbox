import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
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
    ],
    private readonly terminalProbes: TerminalStateProbe[] = [
      new Iterm2TerminalStateProbe(),
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

    const it2api = resolveIterm2ApiPath(this.options.iterm2ApiPath);
    const present = await this.hasSession(it2api, sessionId);
    if (!present) {
      return { presence: "gone", busy: "unknown" };
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

  private async hasSession(it2api: string, sessionId: string): Promise<boolean> {
    try {
      const result = await this.execAsync(it2api, ["list-sessions"]);
      return result.stdout.includes(sessionId);
    } catch {
      return false;
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
