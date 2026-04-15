import test from "node:test";
import assert from "node:assert/strict";
import {
  CodexRuntimePresenceProbe,
  DefaultActivationGate,
  Iterm2TerminalStateProbe,
  ClaudeCodeRuntimePresenceProbe,
  ClaudeCodeTerminalStateProbe,
  TmuxTerminalStateProbe,
} from "../src/runtime_gate";
import { TerminalActivationTarget } from "../src/model";

function makeItermTarget(): TerminalActivationTarget {
  return {
    targetId: "tgt_gate",
    agentId: "agent_codex_demo",
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
    agentId: "agent_codex_tmux",
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
  const probe = new CodexRuntimePresenceProbe(() => {});
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

test("DefaultActivationGate defers when the terminal probe reports busy", async () => {
  const gate = new DefaultActivationGate(
    [new CodexRuntimePresenceProbe(() => {})],
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
      return { stdout: "1 0\n", stderr: "" };
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
      return { stdout: "1 0\n", stderr: "" };
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

test("TmuxTerminalStateProbe reports busy when the active pane shows typed prompt input", async () => {
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

  assert.deepEqual(await probe.check(makeTmuxTarget()), {
    presence: "available",
    busy: "busy",
  });
});

test("TmuxTerminalStateProbe reports unknown when the pane is stable and prompt is empty", async () => {
  const probe = new TmuxTerminalStateProbe(async (_file, args) => {
    if (args[0] === "display-message") {
      return { stdout: "1 0\n", stderr: "" };
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
