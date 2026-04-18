import test from "node:test";
import assert from "node:assert/strict";
import {
  CodexRuntimePresenceProbe,
  CodexTerminalStateProbe,
  DefaultActivationGate,
  Iterm2TerminalStateProbe,
  ClaudeCodeRuntimePresenceProbe,
  ClaudeCodeTerminalStateProbe,
  readFirstLine,
  TmuxTerminalStateProbe,
} from "../src/runtime_gate";
import { TerminalActivationTarget } from "../src/model";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Logger, LogLevel } from "../src/logging";

class RecordingLogger implements Logger {
  constructor(
    public readonly level: LogLevel = "trace",
    private readonly component = "test",
    public readonly records: Array<{ level: LogLevel; event: string; fields?: Record<string, unknown>; component: string }> = [],
  ) {}

  enabled(_level: LogLevel): boolean {
    return true;
  }

  child(component: string): Logger {
    return new RecordingLogger(this.level, `${this.component}.${component}`, this.records);
  }

  error(event: string, fields?: Record<string, unknown>): void {
    this.push("error", event, fields);
  }

  warn(event: string, fields?: Record<string, unknown>): void {
    this.push("warn", event, fields);
  }

  info(event: string, fields?: Record<string, unknown>): void {
    this.push("info", event, fields);
  }

  debug(event: string, fields?: Record<string, unknown>): void {
    this.push("debug", event, fields);
  }

  trace(event: string, fields?: Record<string, unknown>): void {
    this.push("trace", event, fields);
  }

  private push(level: LogLevel, event: string, fields?: Record<string, unknown>): void {
    const record = { level, event, fields, component: this.component };
    this.records.push(record);
  }
}

function makeItermTarget(): TerminalActivationTarget {
  return {
    targetId: "tgt_gate",
    agentId: "agt_demo-agent",
    kind: "terminal",
    status: "active",
    offlineSince: null,
    consecutiveFailures: 0,
    lastDeliveredAt: null,
    lastError: null,
    mode: "agent_prompt",
    notifyLeaseMs: 100,
    runtimeKind: "codex",
    runtimeSessionId: "thread-1",
    runtimePid: 1234,
    backend: "iterm2",
    tmuxPaneId: null,
    tty: null,
    termProgram: "iTerm.app",
    itermSessionId: "4F7A2F18-E5F4-4E27-A391-23953DE1F826",
    createdAt: "2026-04-01T00:00:00.000Z",
    updatedAt: "2026-04-01T00:00:00.000Z",
    lastSeenAt: "2026-04-01T00:00:00.000Z",
  };
}

function makeTmuxTarget(): TerminalActivationTarget {
  return {
    targetId: "tgt_tmux",
    agentId: "agt_tmux-agent",
    kind: "terminal",
    status: "active",
    offlineSince: null,
    consecutiveFailures: 0,
    lastDeliveredAt: null,
    lastError: null,
    mode: "agent_prompt",
    notifyLeaseMs: 100,
    runtimeKind: "codex",
    runtimeSessionId: "thread-tmux-1",
    runtimePid: 1234,
    backend: "tmux",
    tmuxPaneId: "%2",
    tty: "/dev/ttys001",
    termProgram: "tmux",
    itermSessionId: null,
    createdAt: "2026-04-01T00:00:00.000Z",
    updatedAt: "2026-04-01T00:00:00.000Z",
    lastSeenAt: "2026-04-01T00:00:00.000Z",
  };
}

test("CodexRuntimePresenceProbe reports alive for a live pid", async () => {
  const probe = new CodexRuntimePresenceProbe(
    () => {},
    async () => ({
      sessionId: "thread-1",
      filePath: "/tmp/codex-thread-1.jsonl",
    }),
  );
  assert.equal(await probe.check(makeItermTarget()), "alive");
});

test("CodexRuntimePresenceProbe reports gone for ESRCH", async () => {
  const probe = new CodexRuntimePresenceProbe(() => {
    const error = new Error("missing") as NodeJS.ErrnoException;
    error.code = "ESRCH";
    throw error;
  });
  assert.equal(await probe.check(makeItermTarget()), "gone");
});

test("CodexRuntimePresenceProbe reports gone when the session file is missing", async () => {
  const probe = new CodexRuntimePresenceProbe(() => {}, async () => null);
  assert.equal(await probe.check(makeItermTarget()), "gone");
});

test("CodexRuntimePresenceProbe reports unknown when runtimeSessionId is missing", async () => {
  const probe = new CodexRuntimePresenceProbe(() => {}, async () => {
    throw new Error("should not read session file without runtimeSessionId");
  });
  const target = makeItermTarget();
  target.runtimeSessionId = null;
  assert.equal(await probe.check(target), "unknown");
});

test("CodexRuntimePresenceProbe reports unknown when the session file cannot be read conclusively", async () => {
  const probe = new CodexRuntimePresenceProbe(() => {}, async () => "unknown");
  assert.equal(await probe.check(makeItermTarget()), "unknown");
});

test("readFirstLine reads a full first line even when it exceeds 4096 bytes", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentinbox-runtime-gate-"));
  const filePath = path.join(dir, "large-first-line.jsonl");
  const largeJsonLine = JSON.stringify({
    type: "session_meta",
    payload: {
      id: "thread-1",
      cwd: "/tmp/demo",
      instructions: "x".repeat(16_384),
    },
  });

  try {
    await fs.writeFile(filePath, `${largeJsonLine}\n{"type":"next"}\n`, "utf8");
    assert.equal(await readFirstLine(filePath), largeJsonLine);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("Iterm2TerminalStateProbe reports gone when the session is absent", async () => {
  const probe = new Iterm2TerminalStateProbe(async (_file, args) => {
    if (args[0] === "list-sessions") {
      return {
        stdout: "Session \"codex\" id=F1111111-E5F4-4E27-A391-23953DE1F826 (110 x 30)\n",
        stderr: "",
      };
    }
    throw new Error(`unexpected command: ${args.join(" ")}`);
  }, {
    iterm2ApiPath: "/tmp/fake-it2api",
    sleep: async () => {},
  });

  assert.deepEqual(await probe.check(makeItermTarget()), {
    presence: "gone",
    busy: "unknown",
  });
});

test("Iterm2TerminalStateProbe matches session ids exactly", async () => {
  const probe = new Iterm2TerminalStateProbe(async (_file, args) => {
    if (args[0] === "list-sessions") {
      return {
        stdout: [
          "Session \"codex one\" id=4F7A2F18-E5F4-4E27-A391-23953DE1F820 (110 x 30)",
          "Session \"codex two\" id=F1111111-E5F4-4E27-A391-23953DE1F826 (110 x 30)",
        ].join("\n"),
        stderr: "",
      };
    }
    throw new Error(`unexpected command: ${args.join(" ")}`);
  }, {
    iterm2ApiPath: "/tmp/fake-it2api",
    sleep: async () => {},
  });

  assert.deepEqual(await probe.check(makeItermTarget()), {
    presence: "gone",
    busy: "unknown",
  });
});

test("Iterm2TerminalStateProbe reports unknown when it2api listing fails", async () => {
  const probe = new Iterm2TerminalStateProbe(async () => {
    throw new Error("it2api unavailable");
  }, {
    iterm2ApiPath: "/tmp/fake-it2api",
    sleep: async () => {},
  });

  assert.deepEqual(await probe.check(makeItermTarget()), {
    presence: "unknown",
    busy: "unknown",
  });
});

test("Iterm2TerminalStateProbe reports busy when the buffer tail changes", async () => {
  const buffers = ["first snapshot", "second snapshot"];
  const probe = new Iterm2TerminalStateProbe(async (_file, args) => {
    if (args[0] === "list-sessions") {
      return {
        stdout: "Session \"codex\" id=4F7A2F18-E5F4-4E27-A391-23953DE1F826 (110 x 30)\n",
        stderr: "",
      };
    }
    if (args[0] === "get-prompt") {
      throw new Error("prompt unavailable");
    }
    if (args[0] === "get-buffer") {
      return { stdout: `${buffers.shift() ?? "second snapshot"}\n`, stderr: "" };
    }
    throw new Error(`unexpected command: ${args.join(" ")}`);
  }, {
    iterm2ApiPath: "/tmp/fake-it2api",
    sleep: async () => {},
  });

  assert.deepEqual(await probe.check(makeItermTarget()), {
    presence: "available",
    busy: "busy",
  });
});

test("Iterm2TerminalStateProbe reports busy when the stable buffer shows a codex activity marker", async () => {
  const probe = new Iterm2TerminalStateProbe(async (_file, args) => {
    if (args[0] === "list-sessions") {
      return {
        stdout: "Session \"codex\" id=4F7A2F18-E5F4-4E27-A391-23953DE1F826 (110 x 30)\n",
        stderr: "",
      };
    }
    if (args[0] === "get-prompt") {
      throw new Error("prompt unavailable");
    }
    if (args[0] === "get-buffer") {
      return {
        stdout: "workspace\n• Working (1m 23s • esc to interrupt)\n",
        stderr: "",
      };
    }
    throw new Error(`unexpected command: ${args.join(" ")}`);
  }, {
    iterm2ApiPath: "/tmp/fake-it2api",
    sleep: async () => {},
  });

  assert.deepEqual(await probe.check(makeItermTarget()), {
    presence: "available",
    busy: "busy",
  });
});

test("Iterm2TerminalStateProbe reports unknown when the buffer is stable and quiet", async () => {
  const probe = new Iterm2TerminalStateProbe(async (_file, args) => {
    if (args[0] === "list-sessions") {
      return {
        stdout: "Session \"codex\" id=4F7A2F18-E5F4-4E27-A391-23953DE1F826 (110 x 30)\n",
        stderr: "",
      };
    }
    if (args[0] === "get-prompt") {
      throw new Error("prompt unavailable");
    }
    if (args[0] === "get-buffer") {
      return {
        stdout: "workspace\nAll quiet here\n",
        stderr: "",
      };
    }
    throw new Error(`unexpected command: ${args.join(" ")}`);
  }, {
    iterm2ApiPath: "/tmp/fake-it2api",
    sleep: async () => {},
  });

  assert.deepEqual(await probe.check(makeItermTarget()), {
    presence: "available",
    busy: "unknown",
  });
});

test("Iterm2TerminalStateProbe reports unknown when the stable buffer shows visible typed input", async () => {
  const probe = new Iterm2TerminalStateProbe(async (_file, args) => {
    if (args[0] === "list-sessions") {
      return {
        stdout: "Session \"codex\" id=4F7A2F18-E5F4-4E27-A391-23953DE1F826 (110 x 30)\n",
        stderr: "",
      };
    }
    if (args[0] === "get-prompt") {
      throw new Error("prompt unavailable");
    }
    if (args[0] === "get-buffer") {
      return {
        stdout: "workspace\n> agentinbox inbox read --agent-id demo\n",
        stderr: "",
      };
    }
    throw new Error(`unexpected command: ${args.join(" ")}`);
  }, {
    iterm2ApiPath: "/tmp/fake-it2api",
    sleep: async () => {},
  });

  // After PR #116 tightening, generic typing prompts are no longer used to avoid false positives
  // The buffer is stable and shows no active markers, so it returns unknown
  assert.deepEqual(await probe.check(makeItermTarget()), {
    presence: "available",
    busy: "unknown",
  });
});

test("DefaultActivationGate defers when the terminal probe reports busy", async () => {
  const gate = new DefaultActivationGate(
    [new CodexRuntimePresenceProbe(
      () => {},
      async () => ({
        sessionId: "thread-1",
        filePath: "/tmp/codex-thread-1.jsonl",
      }),
    )],
    [{
      supports: () => true,
      async check() {
        return {
          presence: "available" as const,
          busy: "busy" as const,
        };
      },
    }],
  );

  assert.deepEqual(await gate.evaluate(makeItermTarget()), {
    outcome: "defer",
    reason: "terminal_busy",
  });
});

test("DefaultActivationGate defers when Codex looks recently active but not conclusively idle", async () => {
  const gate = new DefaultActivationGate(
    [new CodexRuntimePresenceProbe(
      () => {},
      async () => ({
        sessionId: "thread-1",
        filePath: "/tmp/codex-thread-1.jsonl",
      }),
    )],
    [{
      supports: () => true,
      async check() {
        return {
          presence: "available" as const,
          busy: "idle" as const,
        };
      },
    }],
  );

  assert.deepEqual(await gate.evaluate(makeItermTarget()), {
    outcome: "defer",
    reason: "terminal_recently_active",
  });
});

test("DefaultActivationGate short-circuits terminal probes when runtime is already gone", async () => {
  let terminalChecked = false;
  const gate = new DefaultActivationGate(
    [new CodexRuntimePresenceProbe(() => {
      const error = new Error("missing") as NodeJS.ErrnoException;
      error.code = "ESRCH";
      throw error;
    })],
    [{
      supports: () => true,
      async check() {
        terminalChecked = true;
        return {
          presence: "available" as const,
          busy: "busy" as const,
        };
      },
    }],
  );

  assert.deepEqual(await gate.evaluate(makeItermTarget()), {
    outcome: "offline",
    reason: "runtime_gone",
  });
  assert.equal(terminalChecked, false);
});

test("DefaultActivationGate emits a structured gate decision log", async () => {
  const logger = new RecordingLogger();
  const gate = new DefaultActivationGate(
    [new CodexRuntimePresenceProbe(
      () => {},
      async () => ({
        sessionId: "thread-1",
        filePath: "/tmp/codex-thread-1.jsonl",
      }),
    )],
    [{
      supports: () => true,
      async check() {
        return {
          presence: "available" as const,
          busy: "busy" as const,
        };
      },
    }],
    logger,
  );

  const decision = await gate.evaluate(makeItermTarget());
  assert.deepEqual(decision, {
    outcome: "defer",
    reason: "terminal_busy",
  });

  const logRecord = logger.records.find((record) => record.event === "gate_decision");
  assert.ok(logRecord);
  assert.equal(logRecord.level, "debug");
  assert.equal(logRecord.fields?.runtimePresence, "alive");
  assert.equal(logRecord.fields?.terminalPresence, "available");
  assert.equal(logRecord.fields?.terminalBusy, "busy");
  assert.equal(logRecord.fields?.outcome, "defer");
  assert.equal(logRecord.fields?.reason, "terminal_busy");
});

test("CodexTerminalStateProbe reports busy when the Codex session file was updated recently", async () => {
  const probe = new CodexTerminalStateProbe(
    {
      supports: () => true,
      async check() {
        return {
          presence: "available" as const,
          busy: "unknown" as const,
        };
      },
    },
    {
      supports: () => false,
      async check() {
        throw new Error("tmux probe should not be used");
      },
    },
    async () => ({
      sessionId: "thread-1",
      filePath: "/tmp/codex-thread-1.jsonl",
    }),
    async () => ({ mtimeMs: 199_000 }),
    () => 200_000,
  );

  assert.deepEqual(await probe.check(makeItermTarget()), {
    presence: "available",
    busy: "busy",
  });
});

test("CodexTerminalStateProbe reports idle when the Codex session was only recently active", async () => {
  const probe = new CodexTerminalStateProbe(
    {
      supports: () => true,
      async check() {
        return {
          presence: "available" as const,
          busy: "unknown" as const,
        };
      },
    },
    {
      supports: () => false,
      async check() {
        throw new Error("tmux probe should not be used");
      },
    },
    async () => ({
      sessionId: "thread-1",
      filePath: "/tmp/codex-thread-1.jsonl",
    }),
    async () => ({ mtimeMs: 190_000 }),
    () => 200_000,
  );

  assert.deepEqual(await probe.check(makeItermTarget()), {
    presence: "available",
    busy: "idle",
  });
});

test("TmuxTerminalStateProbe reports gone when the pane is absent", async () => {
  const probe = new TmuxTerminalStateProbe(async (_file, args) => {
    if (args[0] === "display-message") {
      const error = new Error("can't find pane: %2") as Error & { stderr?: string };
      error.stderr = "can't find pane: %2";
      throw error;
    }
    throw new Error(`unexpected command: ${args.join(" ")}`);
  }, {
    sleep: async () => {},
  });

  assert.deepEqual(await probe.check(makeTmuxTarget()), {
    presence: "gone",
    busy: "unknown",
  });
});

test("TmuxTerminalStateProbe trims pane ids in supports()", () => {
  const probe = new TmuxTerminalStateProbe();
  const target = makeTmuxTarget();
  target.tmuxPaneId = "   ";
  assert.equal(probe.supports(target), false);
});

test("TmuxTerminalStateProbe reports unknown when tmux pane lookup fails for non-missing reasons", async () => {
  const probe = new TmuxTerminalStateProbe(async (_file, args) => {
    if (args[0] === "display-message") {
      throw new Error("failed to connect to server");
    }
    throw new Error(`unexpected command: ${args.join(" ")}`);
  }, {
    sleep: async () => {},
  });

  assert.deepEqual(await probe.check(makeTmuxTarget()), {
    presence: "unknown",
    busy: "unknown",
  });
});

test("TmuxTerminalStateProbe reports busy when the buffer tail changes", async () => {
  const buffers = ["first snapshot", "second snapshot"];
  const probe = new TmuxTerminalStateProbe(async (_file, args) => {
    if (args[0] === "display-message") {
      return { stdout: "1 0 0 27 28\n", stderr: "" };
    }
    if (args[0] === "capture-pane") {
      return { stdout: `${buffers.shift() ?? "second snapshot"}\n`, stderr: "" };
    }
    throw new Error(`unexpected command: ${args.join(" ")}`);
  }, {
    sleep: async () => {},
  });

  assert.deepEqual(await probe.check(makeTmuxTarget()), {
    presence: "available",
    busy: "busy",
  });
});

test("TmuxTerminalStateProbe reports busy when the stable buffer shows a codex activity marker", async () => {
  const probe = new TmuxTerminalStateProbe(async (_file, args) => {
    if (args[0] === "display-message") {
      return { stdout: "1 0 0 27 28\n", stderr: "" };
    }
    if (args[0] === "capture-pane") {
      return {
        stdout: "workspace\n• Working (1m 23s • esc to interrupt)\n",
        stderr: "",
      };
    }
    throw new Error(`unexpected command: ${args.join(" ")}`);
  }, {
    sleep: async () => {},
  });

  assert.deepEqual(await probe.check(makeTmuxTarget()), {
    presence: "available",
    busy: "busy",
  });
});

test("TmuxTerminalStateProbe reports busy when the cursor is past a codex prompt prefix on the input row", async () => {
  const probe = new TmuxTerminalStateProbe(async (_file, args) => {
    if (args[0] === "display-message") {
      return { stdout: "1 0 6 27 28\n", stderr: "" };
    }
    if (args[0] === "capture-pane") {
      return {
        stdout: "question text\n\n› abcdefg\n",
        stderr: "",
      };
    }
    throw new Error(`unexpected command: ${args.join(" ")}`);
  }, {
    sleep: async () => {},
  });

  assert.deepEqual(await probe.check(makeTmuxTarget()), {
    presence: "available",
    busy: "busy",
  });
});

test("TmuxTerminalStateProbe does not mark busy from cursor hint when the cursor is still inside the prompt prefix", async () => {
  const probe = new TmuxTerminalStateProbe(async (_file, args) => {
    if (args[0] === "display-message") {
      return { stdout: "1 0 1 27 28\n", stderr: "" };
    }
    if (args[0] === "capture-pane") {
      return {
        stdout: "question text\n\n› abcdefg\n",
        stderr: "",
      };
    }
    throw new Error(`unexpected command: ${args.join(" ")}`);
  }, {
    sleep: async () => {},
  });

  assert.deepEqual(await probe.check(makeTmuxTarget()), {
    presence: "available",
    busy: "unknown",
  });
});

test("TmuxTerminalStateProbe does not mark busy from cursor hint when the cursor row is not on the prompt line", async () => {
  const probe = new TmuxTerminalStateProbe(async (_file, args) => {
    if (args[0] === "display-message") {
      return { stdout: "1 0 6 26 28\n", stderr: "" };
    }
    if (args[0] === "capture-pane") {
      return {
        stdout: "question text\n\n› abcdefg\n",
        stderr: "",
      };
    }
    throw new Error(`unexpected command: ${args.join(" ")}`);
  }, {
    sleep: async () => {},
  });

  assert.deepEqual(await probe.check(makeTmuxTarget()), {
    presence: "available",
    busy: "unknown",
  });
});

test("TmuxTerminalStateProbe falls back to prompt heuristics when the cursor row is outside the captured tail", async () => {
  const probe = new TmuxTerminalStateProbe(async (_file, args) => {
    if (args[0] === "display-message") {
      return { stdout: "1 0 6 10 28\n", stderr: "" };
    }
    if (args[0] === "capture-pane") {
      return {
        stdout: "question text\n\n› abcdefg\n",
        stderr: "",
      };
    }
    throw new Error(`unexpected command: ${args.join(" ")}`);
  }, {
    sleep: async () => {},
  });

  // After PR #116 tightening, when cursor-aware mapping is uncertain we do not
  // fall back to generic prompt heuristics, to avoid false positives.
  assert.deepEqual(await probe.check(makeTmuxTarget()), {
    presence: "available",
    busy: "unknown",
  });
});

test("TmuxTerminalStateProbe reports unknown when cursor metadata is unavailable and prompt heuristics would apply", async () => {
  const probe = new TmuxTerminalStateProbe(async (_file, args) => {
    if (args[0] === "display-message") {
      return { stdout: "1 0\n", stderr: "" };
    }
    if (args[0] === "capture-pane") {
      return {
        stdout: "question text\n\n› abcdefg\n",
        stderr: "",
      };
    }
    throw new Error(`unexpected command: ${args.join(" ")}`);
  }, {
    sleep: async () => {},
  });

  // After PR #116 tightening, when cursor metadata is unavailable, we do NOT fall back to
  // generic prompt heuristics to avoid false positives
  assert.deepEqual(await probe.check(makeTmuxTarget()), {
    presence: "available",
    busy: "unknown",
  });
});

test("TmuxTerminalStateProbe reports busy when the cursor is past a claude_code prompt prefix on the input row", async () => {
  const target = makeTmuxTarget();
  target.runtimeKind = "claude_code";
  const probe = new TmuxTerminalStateProbe(async (_file, args) => {
    if (args[0] === "display-message") {
      return { stdout: "1 0 7 27 28\n", stderr: "" };
    }
    if (args[0] === "capture-pane") {
      return {
        stdout: "question text\n\n❯ rewrite this\n",
        stderr: "",
      };
    }
    throw new Error(`unexpected command: ${args.join(" ")}`);
  }, {
    sleep: async () => {},
  });

  assert.deepEqual(await probe.check(target), {
    presence: "available",
    busy: "busy",
  });
});

test("TmuxTerminalStateProbe reports unknown when the pane is stable and prompt is empty", async () => {
  const probe = new TmuxTerminalStateProbe(async (_file, args) => {
    if (args[0] === "display-message") {
      return { stdout: "1 0 0 27 28\n", stderr: "" };
    }
    if (args[0] === "capture-pane") {
      return {
        stdout: "workspace\nAll quiet here\n› \n",
        stderr: "",
      };
    }
    throw new Error(`unexpected command: ${args.join(" ")}`);
  }, {
    sleep: async () => {},
  });

  assert.deepEqual(await probe.check(makeTmuxTarget()), {
    presence: "available",
    busy: "unknown",
  });
});

// Claude Code Runtime Presence Probe Tests
function makeClaudeCodeTarget(): TerminalActivationTarget {
  return {
    targetId: "tgt_claude",
    agentId: "agent_claude_demo",
    kind: "terminal",
    status: "active",
    offlineSince: null,
    consecutiveFailures: 0,
    lastDeliveredAt: null,
    lastError: null,
    mode: "agent_prompt",
    notifyLeaseMs: 100,
    runtimeKind: "claude_code",
    runtimeSessionId: "f6037b9e-b970-475f-b339-5c5b286aceac",
    runtimePid: 48663,
    backend: "iterm2",
    tmuxPaneId: null,
    tty: null,
    termProgram: "iTerm.app",
    itermSessionId: "E551BC86-9787-4C74-B297-F0A3EC3C9F46",
    createdAt: "2026-04-15T00:00:00.000Z",
    updatedAt: "2026-04-15T00:00:00.000Z",
    lastSeenAt: "2026-04-15T00:00:00.000Z",
  };
}

test("ClaudeCodeRuntimePresenceProbe supports claude_code runtime with PID", () => {
  const probe = new ClaudeCodeRuntimePresenceProbe();
  assert.equal(probe.supports(makeClaudeCodeTarget()), true);
});

test("ClaudeCodeRuntimePresenceProbe does not support targets without PID", () => {
  const probe = new ClaudeCodeRuntimePresenceProbe();
  const target = makeClaudeCodeTarget();
  target.runtimePid = null;
  assert.equal(probe.supports(target), false);
});

test("ClaudeCodeRuntimePresenceProbe reports alive for live process with valid session", async () => {
  const mockSessionReader = async () => ({
    sessionId: "f6037b9e-b970-475f-b339-5c5b286aceac",
    cwd: "/Users/jolestar/opensource/src/github.com/holon-run/agentinbox",
  });
  const probe = new ClaudeCodeRuntimePresenceProbe(() => {}, mockSessionReader);
  assert.equal(await probe.check(makeClaudeCodeTarget()), "alive");
});

test("ClaudeCodeRuntimePresenceProbe reports gone for ESRCH", async () => {
  const probe = new ClaudeCodeRuntimePresenceProbe(() => {
    const error = new Error("missing") as NodeJS.ErrnoException;
    error.code = "ESRCH";
    throw error;
  });
  assert.equal(await probe.check(makeClaudeCodeTarget()), "gone");
});

test("ClaudeCodeTerminalStateProbe supports claude_code runtime", () => {
  const probe = new ClaudeCodeTerminalStateProbe();
  assert.equal(probe.supports(makeClaudeCodeTarget()), true);
});

test("ClaudeCodeTerminalStateProbe returns unknown for missing PID/sessionId", async () => {
  const probe = new ClaudeCodeTerminalStateProbe();
  const target = makeClaudeCodeTarget();
  target.runtimePid = null;
  assert.deepEqual(await probe.check(target), {
    presence: "unknown",
    busy: "unknown",
  });
});

test("ClaudeCodeRuntimePresenceProbe reports gone when session reader returns null", async () => {
  const mockSessionReader = async () => null;
  const probe = new ClaudeCodeRuntimePresenceProbe(() => {}, mockSessionReader);
  assert.equal(await probe.check(makeClaudeCodeTarget()), "gone");
});

test("ClaudeCodeRuntimePresenceProbe reports gone when session ID mismatches", async () => {
  const mockSessionReader = async () => ({
    sessionId: "different-session-id",
    cwd: "/Users/jolestar/opensource/src/github.com/holon-run/agentinbox",
  });
  const probe = new ClaudeCodeRuntimePresenceProbe(() => {}, mockSessionReader);
  assert.equal(await probe.check(makeClaudeCodeTarget()), "gone");
});

test("ClaudeCodeTerminalStateProbe detects busy state from recent log activity", async () => {
  const now = Date.now();
  const mockSessionReader = async () => ({
    sessionId: "f6037b9e-b970-475f-b339-5c5b286aceac",
    cwd: "/Users/jolestar/opensource/src/github.com/holon-run/agentinbox",
  });
  const mockStatReader = async () => ({ mtimeMs: now - 1000 }); // 1 second ago
  const mockSleep = async () => {};
  const probe = new ClaudeCodeTerminalStateProbe(mockSessionReader, mockStatReader, mockSleep);

  const result = await probe.check(makeClaudeCodeTarget());
  assert.equal(result.busy, "busy");
});

test("ClaudeCodeTerminalStateProbe reports idle for older log activity", async () => {
  const now = Date.now();
  const mockSessionReader = async () => ({
    sessionId: "f6037b9e-b970-475f-b339-5c5b286aceac",
    cwd: "/Users/jolestar/opensource/src/github.com/holon-run/agentinbox",
  });
  const mockStatReader = async () => ({ mtimeMs: now - 10000 }); // 10 seconds ago
  const mockSleep = async () => {};
  const probe = new ClaudeCodeTerminalStateProbe(mockSessionReader, mockStatReader, mockSleep);

  const result = await probe.check(makeClaudeCodeTarget());
  assert.equal(result.busy, "idle");
});

test("Iterm2TerminalStateProbe does not support claude_code runtime", () => {
  const probe = new Iterm2TerminalStateProbe();
  const claudeTarget = makeClaudeCodeTarget();
  assert.equal(probe.supports(claudeTarget), false);
});

test("Iterm2TerminalStateProbe supports non-claude iTerm2 targets", () => {
  const probe = new Iterm2TerminalStateProbe();
  const codexTarget = makeItermTarget(); // This has runtimeKind: "codex"
  assert.equal(probe.supports(codexTarget), true);
});

test("Iterm2TerminalStateProbe with Python API reports busy when cursor is at prompt with input", async () => {
  const probe = new Iterm2TerminalStateProbe(
    async (file, args) => {
      if (file === "python3") {
        // Simulate Python API response with the cursor on the in-bounds prompt line.
        return {
          stdout: JSON.stringify({
            status: "available",
            cursor: { x: 10, y: 4 }, // Last line (index 4) in 5-line screen; cursor at last line.
            screen_height: 5,
            start_line: 0,
            lines: [
              "line 1",
              "line 2",
              "line 3",
              "line 4",
              "› test input" // Cursor is on this prompt line (index 4), after the entered input.
            ]
          }),
          stderr: ""
        };
      }
      throw new Error("Unexpected command: " + file);
    },
    {
      pythonScriptPath: "/tmp/fake-python-probe.py",
      sampleDelayMs: 0,
      sleep: async () => {}
    }
  );

  const target = makeItermTarget();
  const result = await probe.check(target);

  assert.equal(result.presence, "available");
  assert.equal(result.busy, "busy");
});

test("Iterm2TerminalStateProbe with Python API reports unknown when cursor is not at prompt line", async () => {
  const probe = new Iterm2TerminalStateProbe(
    async (file, args) => {
      if (file === "python3") {
        // Simulate Python API response with cursor not at last line
        return {
          stdout: JSON.stringify({
            status: "available",
            cursor: { x: 5, y: 2 }, // Cursor at line 2, not at last line (4)
            screen_height: 5,
            start_line: 0,
            lines: [
              "line 1",
              "line 2 with cursor",
              "line 3",
              "line 4",
              "› test input"
            ]
          }),
          stderr: ""
        };
      }
      throw new Error("Unexpected command");
    },
    {
      pythonScriptPath: "/tmp/fake-python-probe.py",
      sampleDelayMs: 0,
      sleep: async () => {}
    }
  );

  const target = makeItermTarget();
  const result = await probe.check(target);

  assert.equal(result.presence, "available");
  assert.equal(result.busy, "unknown");
});

test("Iterm2TerminalStateProbe with Python API normalizes tail whitespace before diffing snapshots", async () => {
  const snapshots = [
    {
      status: "available",
      cursor: { x: 5, y: 2 },
      screen_height: 5,
      start_line: 0,
      lines: [
        "line 1   ",
        "line 2 with cursor\r",
        "line 3",
        "line 4   ",
        "› test input   ",
      ],
    },
    {
      status: "available",
      cursor: { x: 5, y: 2 },
      screen_height: 5,
      start_line: 0,
      lines: [
        "line 1",
        "line 2 with cursor",
        "line 3",
        "line 4",
        "› test input",
      ],
    },
  ];

  const probe = new Iterm2TerminalStateProbe(
    async (file) => {
      if (file === "python3") {
        return {
          stdout: JSON.stringify(snapshots.shift()),
          stderr: "",
        };
      }
      throw new Error("Unexpected command");
    },
    {
      pythonScriptPath: "/tmp/fake-python-probe.py",
      sampleDelayMs: 0,
      sleep: async () => {},
    }
  );

  const result = await probe.check(makeItermTarget());
  assert.equal(result.presence, "available");
  assert.equal(result.busy, "unknown");
});

test("Iterm2TerminalStateProbe with Python API sees active markers above the old 5-line tail", async () => {
  const probe = new Iterm2TerminalStateProbe(
    async (file) => {
      if (file === "python3") {
        return {
          stdout: JSON.stringify({
            status: "available",
            cursor: { x: 0, y: 19 },
            screen_height: 20,
            start_line: 0,
            lines: [
              "workspace",
              "build logs",
              "• Working (1m 23s • esc to interrupt)",
              ...Array.from({ length: 17 }, (_, index) => `line ${index + 4}`),
            ],
          }),
          stderr: "",
        };
      }
      throw new Error("Unexpected command");
    },
    {
      pythonScriptPath: "/tmp/fake-python-probe.py",
      sampleDelayMs: 0,
      sleep: async () => {},
    }
  );

  const result = await probe.check(makeItermTarget());
  assert.equal(result.presence, "available");
  assert.equal(result.busy, "busy");
});

test("Iterm2TerminalStateProbe with Python API falls back to CLI when Python fails", async () => {
  const probe = new Iterm2TerminalStateProbe(
    async (file, args) => {
      if (file === "python3") {
        throw new Error("Python not available");
      }
      // Fall back to it2api
      if (file === "/tmp/fake-it2api") {
        if (args[0] === "list-sessions") {
          return {
            stdout: `Session "test" id=4F7A2F18-E5F4-4E27-A391-23953DE1F826 (110 x 30)`,
            stderr: ""
          };
        }
        if (args[0] === "get-buffer") {
          return {
            stdout: "more content\n› test input",
            stderr: ""
          };
        }
      }
      throw new Error("Unexpected command");
    },
    {
      pythonScriptPath: "/tmp/fake-python-probe.py",
      iterm2ApiPath: "/tmp/fake-it2api",
      sampleDelayMs: 0,
      sleep: async () => {}
    }
  );

  const target = makeItermTarget();
  const result = await probe.check(target);

  // After PR #116 tightening, CLI fallback no longer uses generic typing prompts to avoid false positives
  // The buffer is stable and shows no active markers, so it returns unknown
  assert.equal(result.presence, "available");
  assert.equal(result.busy, "unknown");
});

test("Iterm2TerminalStateProbe with Python API reports gone when session is gone", async () => {
  const probe = new Iterm2TerminalStateProbe(
    async (file, args) => {
      if (file === "python3") {
        // Simulate Python API response for gone session
        return {
          stdout: JSON.stringify({
            status: "gone"
          }),
          stderr: ""
        };
      }
      throw new Error("Unexpected command");
    },
    {
      pythonScriptPath: "/tmp/fake-python-probe.py",
      sampleDelayMs: 0,
      sleep: async () => {}
    }
  );

  const target = makeItermTarget();
  const result = await probe.check(target);

  assert.equal(result.presence, "gone");
  assert.equal(result.busy, "unknown");
});
