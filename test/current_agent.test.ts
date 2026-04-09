import assert from "node:assert/strict";
import test from "node:test";
import { annotateAgents, AgentWithTargets, resolveCurrentAgent } from "../src/current_agent";

function makeAgentRecord(input: {
  agentId: string;
  status?: "active" | "offline";
  runtimeKind?: "codex" | "claude_code" | "unknown";
  runtimeSessionId?: string | null;
  activationTargets?: AgentWithTargets["activationTargets"];
}): AgentWithTargets {
  return {
    agent: {
      agentId: input.agentId,
      status: input.status ?? "active",
      offlineSince: null,
      runtimeKind: input.runtimeKind ?? "codex",
      runtimeSessionId: input.runtimeSessionId ?? null,
      createdAt: "2026-04-10T00:00:00Z",
      updatedAt: "2026-04-10T00:00:00Z",
      lastSeenAt: "2026-04-10T00:00:00Z",
    },
    activationTargets: input.activationTargets ?? [],
  };
}

test("resolveCurrentAgent prefers terminal identity over runtime identity", () => {
  const agents: AgentWithTargets[] = [
    makeAgentRecord({
      agentId: "agent-runtime",
      runtimeSessionId: "thread-1",
      activationTargets: [{
        targetId: "tgt-runtime",
        kind: "terminal",
        status: "active",
        backend: "tmux",
        tmuxPaneId: "%101",
        runtimeKind: "codex",
        runtimeSessionId: "thread-1",
      }],
    }),
    makeAgentRecord({
      agentId: "agent-terminal",
      runtimeSessionId: "thread-2",
      activationTargets: [{
        targetId: "tgt-terminal",
        kind: "terminal",
        status: "active",
        backend: "tmux",
        tmuxPaneId: "%202",
        runtimeKind: "codex",
        runtimeSessionId: "thread-2",
      }],
    }),
  ];

  const current = resolveCurrentAgent(agents, {
    backend: "tmux",
    tmuxPaneId: "%202",
    tty: "/dev/ttys001",
    termProgram: "tmux",
    itermSessionId: null,
    runtimeKind: "codex",
    runtimeSessionId: "thread-1",
  });

  assert.deepEqual(current, {
    agentId: "agent-terminal",
    bindingKind: "session_bound",
    matchesCurrentTerminal: true,
    matchesCurrentRuntime: false,
    terminalIdentity: "tmux:%202",
  });
});

test("annotateAgents marks current and detached agents correctly", () => {
  const agents: AgentWithTargets[] = [
    makeAgentRecord({
      agentId: "agent-current",
      runtimeSessionId: "thread-current",
      activationTargets: [{
        targetId: "tgt-current",
        kind: "terminal",
        status: "active",
        backend: "iterm2",
        itermSessionId: "SESSION-1",
        tty: "/dev/ttys009",
        runtimeKind: "codex",
        runtimeSessionId: "thread-current",
      }],
    }),
    makeAgentRecord({
      agentId: "agent-detached",
      runtimeSessionId: null,
    }),
  ];

  const annotated = annotateAgents(agents, {
    backend: "iterm2",
    tty: "/dev/ttys009",
    termProgram: "iTerm.app",
    itermSessionId: "SESSION-1",
    runtimeKind: "codex",
    runtimeSessionId: "thread-current",
  });

  assert.equal(annotated.currentAgentId, "agent-current");
  assert.equal(annotated.agents[0]?.isCurrent, true);
  assert.equal(annotated.agents[0]?.terminalIdentity, "iterm2:SESSION-1");
  assert.equal(annotated.agents[0]?.bindingKind, "session_bound");
  assert.equal(annotated.agents[1]?.isCurrent, false);
  assert.equal(annotated.agents[1]?.bindingKind, "detached");
  assert.equal(annotated.agents[1]?.terminalIdentity, null);
});

test("resolveCurrentAgent ignores offline agents and offline terminal targets", () => {
  const agents: AgentWithTargets[] = [
    makeAgentRecord({
      agentId: "agent-offline-target",
      activationTargets: [{
        targetId: "tgt-offline",
        kind: "terminal",
        status: "offline",
        backend: "tmux",
        tmuxPaneId: "%501",
        runtimeKind: "codex",
        runtimeSessionId: "thread-offline-target",
      }],
    }),
    makeAgentRecord({
      agentId: "agent-offline-agent",
      status: "offline",
      activationTargets: [{
        targetId: "tgt-active",
        kind: "terminal",
        status: "active",
        backend: "tmux",
        tmuxPaneId: "%501",
        runtimeKind: "codex",
        runtimeSessionId: "thread-offline-agent",
      }],
    }),
  ];

  const current = resolveCurrentAgent(agents, {
    backend: "tmux",
    tmuxPaneId: "%501",
    tty: "/dev/ttys501",
    termProgram: "tmux",
    itermSessionId: null,
    runtimeKind: "codex",
    runtimeSessionId: "thread-offline-target",
  });

  assert.equal(current, null);
});
