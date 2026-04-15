import test from "node:test";
import assert from "node:assert/strict";
import {
  CodexRuntimePresenceProbe,
  DefaultActivationGate,
  Iterm2TerminalStateProbe,
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
    itermSessionId: "SESSION-1",
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
      return { stdout: "OTHER-SESSION\n", stderr: "" };
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

test("Iterm2TerminalStateProbe reports busy when the buffer tail changes", async () => {
  const buffers = ["first snapshot", "second snapshot"];
  const probe = new Iterm2TerminalStateProbe(async (_file, args) => {
    if (args[0] === "list-sessions") {
      return { stdout: "SESSION-1\n", stderr: "" };
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
      return { stdout: "SESSION-1\n", stderr: "" };
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
      return { stdout: "SESSION-1\n", stderr: "" };
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
