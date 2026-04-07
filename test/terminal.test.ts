import test from "node:test";
import assert from "node:assert/strict";
import { assignedAgentIdFromContext, detectTerminalContext, TerminalDispatcher } from "../src/terminal";
import { TerminalTarget } from "../src/model";

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

test("TerminalDispatcher uses osascript for iTerm2 targets", async () => {
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
  });

  const target: TerminalTarget = {
    targetId: "term_1",
    agentId: "agent_codex_abc",
    runtimeKind: "codex",
    runtimeSessionId: "thread-1",
    backend: "iterm2",
    mode: "agent_prompt",
    tmuxPaneId: null,
    tty: null,
    termProgram: "iTerm.app",
    itermSessionId: "4B4CB6B2-A73B-4420-94A7-BD2CA216A285",
    notifyLeaseMs: 600000,
    createdAt: "2026-04-07T00:00:00.000Z",
    updatedAt: "2026-04-07T00:00:00.000Z",
    lastSeenAt: "2026-04-07T00:00:00.000Z",
  };

  await dispatcher.dispatch(target, "AgentInbox: hello");

  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, "osascript");
  assert.deepEqual(calls[0].args.slice(0, 1), ["-e"]);
  assert.equal(calls[0].env?.TARGET_SESSION_ID, "4B4CB6B2-A73B-4420-94A7-BD2CA216A285");
  assert.equal(calls[0].env?.AGENT_PROMPT, "AgentInbox: hello");
  assert.match(calls[0].args[1] ?? "", /select/);
  assert.match(calls[0].args[1] ?? "", /write text promptText newline YES/);
});
