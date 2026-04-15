import test from "node:test";
import assert from "node:assert/strict";
import { assignedAgentIdFromContext, detectTerminalContext, TerminalDispatcher } from "../src/terminal";
import { TerminalActivationTarget } from "../src/model";

test("detectTerminalContext derives codex runtime and iTerm2 session", () => {
  const detected = detectTerminalContext({
    CODEX_THREAD_ID: "019d57fd-6524-7e20-a850-a89e81957100",
    ITERM_SESSION_ID: "w3t1p3:4B4CB6B2-A73B-4420-94A7-BD2CA216A285",
    TERM_PROGRAM: "iTerm.app",
  });

  assert.equal(detected.runtimeKind, "codex");
  assert.equal(detected.runtimeSessionId, "019d57fd-6524-7e20-a850-a89e81957100");
  assert.equal(detected.backend, "iterm2");
  assert.equal(detected.itermSessionId, "4B4CB6B2-A73B-4420-94A7-BD2CA216A285");
  assert.equal(detected.termProgram, "iTerm.app");
});

test("detectTerminalContext prefers tmux and records claude session ids", () => {
  const detected = detectTerminalContext({
    CLAUDE_CODE_SESSION_ID: "claude-session-42",
    TMUX_PANE: "%7",
    TERM_PROGRAM: "iTerm.app",
    TERM_SESSION_ID: "w3t1p3:SESSION",
  });

  assert.equal(detected.runtimeKind, "claude_code");
  assert.equal(detected.runtimeSessionId, "claude-session-42");
  assert.equal(detected.backend, "tmux");
  assert.equal(detected.tmuxPaneId, "%7");
  assert.equal(detected.itermSessionId, "SESSION");
});

test("assignedAgentIdFromContext prefers runtime session ids", () => {
  const agentId = assignedAgentIdFromContext({
    runtimeKind: "codex",
    runtimeSessionId: "019d57fd-6524-7e20-a850-a89e81957100",
    backend: "iterm2",
    itermSessionId: "4B4CB6B2-A73B-4420-94A7-BD2CA216A285",
  });

  assert.equal(agentId, "agent_codex_019d57fd65247e20a850a89e81957100");
});

test("TerminalDispatcher uses two-step it2api submission for iTerm2 targets", async () => {
  const calls: Array<{ file: string; args: string[]; env?: NodeJS.ProcessEnv | undefined }> = [];
  const dispatcher = new TerminalDispatcher(async (file, args, options) => {
    calls.push({
      file,
      args: [...args],
      env: options?.env as NodeJS.ProcessEnv | undefined,
    });
    return {
      stdout: "sent\n",
      stderr: "",
    };
  }, {
    iterm2ApiPath: "/tmp/fake-it2api",
  });

  const target: TerminalActivationTarget = {
    targetId: "tgt_1",
    agentId: "agent_codex_abc",
    kind: "terminal",
    status: "active",
    offlineSince: null,
    consecutiveFailures: 0,
    lastDeliveredAt: null,
    lastError: null,
    mode: "agent_prompt",
    notifyLeaseMs: 600000,
    runtimeKind: "codex",
    runtimeSessionId: "thread-1",
    backend: "iterm2",
    tmuxPaneId: null,
    tty: null,
    termProgram: "iTerm.app",
    itermSessionId: "4B4CB6B2-A73B-4420-94A7-BD2CA216A285",
    createdAt: "2026-04-07T00:00:00.000Z",
    updatedAt: "2026-04-07T00:00:00.000Z",
    lastSeenAt: "2026-04-07T00:00:00.000Z",
  };

  await dispatcher.dispatch(target, "AgentInbox: hello");

  assert.equal(calls.length, 2);
  assert.match(calls[0].file, /it2api$/);
  assert.deepEqual(calls[0].args, [
    "send-text",
    "4B4CB6B2-A73B-4420-94A7-BD2CA216A285",
    "AgentInbox: hello",
  ]);
  assert.match(calls[1].file, /it2api$/);
  assert.deepEqual(calls[1].args, [
    "send-text",
    "4B4CB6B2-A73B-4420-94A7-BD2CA216A285",
    "\r",
  ]);
});

test("TerminalDispatcher uses literal text plus carriage return for tmux targets", async () => {
  const calls: Array<{ file: string; args: string[] }> = [];
  const dispatcher = new TerminalDispatcher(async (file, args) => {
    calls.push({
      file,
      args: [...args],
    });
    return {
      stdout: "sent\n",
      stderr: "",
    };
  });

  const target: TerminalActivationTarget = {
    targetId: "tgt_tmux_1",
    agentId: "agent_codex_tmux",
    kind: "terminal",
    status: "active",
    offlineSince: null,
    consecutiveFailures: 0,
    lastDeliveredAt: null,
    lastError: null,
    mode: "agent_prompt",
    notifyLeaseMs: 600000,
    runtimeKind: "codex",
    runtimeSessionId: "thread-tmux-1",
    backend: "tmux",
    tmuxPaneId: "%2",
    tty: null,
    termProgram: "tmux",
    itermSessionId: null,
    createdAt: "2026-04-07T00:00:00.000Z",
    updatedAt: "2026-04-07T00:00:00.000Z",
    lastSeenAt: "2026-04-07T00:00:00.000Z",
  };

  await dispatcher.dispatch(target, "AgentInbox: hello");

  assert.equal(calls.length, 2);
  assert.equal(calls[0].file, "tmux");
  assert.deepEqual(calls[0].args, [
    "send-keys",
    "-t",
    "%2",
    "-l",
    "AgentInbox: hello",
  ]);
  assert.equal(calls[1].file, "tmux");
  assert.deepEqual(calls[1].args, [
    "send-keys",
    "-t",
    "%2",
    "-l",
    "\r",
  ]);
});
