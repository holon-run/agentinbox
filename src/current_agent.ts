import { ActivationTarget, Agent, RuntimeKind, TerminalBackend } from "./model";
import { DetectedTerminalContext } from "./terminal";

export type BindingKind = "session_bound" | "detached";

export interface TerminalTargetSummary {
  targetId: string;
  kind: "terminal";
  status: "active" | "offline";
  backend: TerminalBackend;
  tmuxPaneId?: string | null;
  tty?: string | null;
  termProgram?: string | null;
  itermSessionId?: string | null;
  runtimeKind?: RuntimeKind | null;
  runtimeSessionId?: string | null;
  runtimePid?: number | null;
}

export interface WebhookTargetSummary {
  targetId: string;
  kind: "webhook";
  status: "active" | "offline";
}

export type ActivationTargetSummary = TerminalTargetSummary | WebhookTargetSummary;

export interface AgentWithTargets {
  agent: Agent;
  activationTargets: ActivationTargetSummary[];
}

export interface CurrentAgentMatch {
  agentId: string;
  bindingKind: BindingKind;
  matchesCurrentTerminal: boolean;
  matchesCurrentRuntime: boolean;
  terminalIdentity: string | null;
}

export interface AnnotatedAgent extends Agent {
  bindingKind: BindingKind;
  matchesCurrentTerminal: boolean;
  matchesCurrentRuntime: boolean;
  terminalIdentity: string | null;
  isCurrent: boolean;
}

export function summarizeActivationTarget(target: ActivationTarget): ActivationTargetSummary {
  if (target.kind === "terminal") {
    return {
      targetId: target.targetId,
      kind: "terminal",
      status: target.status,
      backend: target.backend,
      tmuxPaneId: target.tmuxPaneId ?? null,
      tty: target.tty ?? null,
      termProgram: target.termProgram ?? null,
      itermSessionId: target.itermSessionId ?? null,
      runtimeKind: target.runtimeKind ?? null,
      runtimeSessionId: target.runtimeSessionId ?? null,
      runtimePid: target.runtimePid ?? null,
    };
  }
  return {
    targetId: target.targetId,
    kind: "webhook",
    status: target.status,
  };
}

export function resolveCurrentAgent(
  agents: AgentWithTargets[],
  context: DetectedTerminalContext | null,
): CurrentAgentMatch | null {
  if (!context) {
    return null;
  }

  const agent = resolveAgentRecord(agents, context);
  if (!agent) {
    return null;
  }

  return {
    agentId: agent.agent.agentId,
    bindingKind: bindingKindForAgent(agent),
    matchesCurrentTerminal: matchesCurrentTerminal(agent, context),
    matchesCurrentRuntime: matchesCurrentRuntime(agent, context),
    terminalIdentity: terminalIdentityForAgent(agent),
  };
}

export function annotateAgents(
  agents: AgentWithTargets[],
  context: DetectedTerminalContext | null,
): { currentAgentId: string | null; agents: AnnotatedAgent[] } {
  const current = resolveCurrentAgent(agents, context);
  return {
    currentAgentId: current?.agentId ?? null,
    agents: agents.map((entry) => ({
      ...entry.agent,
      bindingKind: bindingKindForAgent(entry),
      matchesCurrentTerminal: context ? matchesCurrentTerminal(entry, context) : false,
      matchesCurrentRuntime: context ? matchesCurrentRuntime(entry, context) : false,
      terminalIdentity: terminalIdentityForAgent(entry),
      isCurrent: current?.agentId === entry.agent.agentId,
    })),
  };
}

function resolveAgentRecord(
  agents: AgentWithTargets[],
  context: DetectedTerminalContext,
): AgentWithTargets | null {
  if (context.tmuxPaneId) {
    const match = agents.find((agent) =>
      activeTerminalTargets(agent).some((target) => target.backend === "tmux" && target.tmuxPaneId === context.tmuxPaneId),
    );
    if (match) {
      return match;
    }
  }

  if (context.itermSessionId) {
    const match = agents.find((agent) =>
      activeTerminalTargets(agent).some((target) => target.backend === "iterm2" && target.itermSessionId === context.itermSessionId),
    );
    if (match) {
      return match;
    }
  }

  if (context.tty) {
    const match = agents.find((agent) =>
      activeTerminalTargets(agent).some((target) => target.tty === context.tty),
    );
    if (match) {
      return match;
    }
  }

  if (context.runtimeSessionId) {
    const match = agents.find((agent) => matchesCurrentRuntime(agent, context));
    if (match) {
      return match;
    }
  }

  return null;
}

function bindingKindForAgent(agent: AgentWithTargets): BindingKind {
  return activeTerminalTargets(agent).length > 0 ? "session_bound" : "detached";
}

function terminalTargets(agent: AgentWithTargets): TerminalTargetSummary[] {
  return agent.activationTargets.filter((target): target is TerminalTargetSummary => target.kind === "terminal");
}

function activeTerminalTargets(agent: AgentWithTargets): TerminalTargetSummary[] {
  if (agent.agent.status !== "active") {
    return [];
  }
  return terminalTargets(agent).filter((target) => target.status === "active");
}

function terminalIdentityForAgent(agent: AgentWithTargets): string | null {
  const target = activeTerminalTargets(agent)[0];
  if (!target) {
    return null;
  }
  if (target.tmuxPaneId) {
    return `tmux:${target.tmuxPaneId}`;
  }
  if (target.itermSessionId) {
    return `iterm2:${target.itermSessionId}`;
  }
  if (target.tty) {
    return `tty:${target.tty}`;
  }
  return null;
}

function matchesCurrentTerminal(agent: AgentWithTargets, context: DetectedTerminalContext): boolean {
  return activeTerminalTargets(agent).some((target) =>
    (context.tmuxPaneId != null && target.tmuxPaneId === context.tmuxPaneId)
    || (context.itermSessionId != null && target.itermSessionId === context.itermSessionId)
    || (context.tty != null && target.tty === context.tty),
  );
}

function matchesCurrentRuntime(agent: AgentWithTargets, context: DetectedTerminalContext): boolean {
  if (agent.agent.status !== "active") {
    return false;
  }
  if (!context.runtimeSessionId) {
    return false;
  }
  return activeTerminalTargets(agent).some((target) =>
    target.runtimeKind === context.runtimeKind && target.runtimeSessionId === context.runtimeSessionId,
  ) || (
    agent.agent.runtimeKind === context.runtimeKind
    && agent.agent.runtimeSessionId === context.runtimeSessionId
  );
}
