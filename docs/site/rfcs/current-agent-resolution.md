---
title: Current Agent Resolution And Safe Agent-Scoped CLI Behavior
date: 2026-04-09
type: page
summary: Define how AgentInbox CLI should resolve the current agent, warn on cross-session targeting, and auto-register session-bound agents.
---

# Current Agent Resolution And Safe Agent-Scoped CLI Behavior

## Summary

`AgentInbox` should make the common case safe by default:

- when the user is inside a terminal-bound agent session, agent-scoped CLI
  commands should operate on that current session by default
- when the user explicitly targets another agent, the CLI should allow it, but
  surface structured warnings when the target looks like another session-bound
  agent
- when no current agent is registered but the current session can be registered,
  the CLI should auto-register for the current-session path

The CLI should not treat this as a hard permission boundary. It is an operator
footgun reduction policy.

## Problem

Today a shared `AGENTINBOX_HOME` can contain multiple agents from different
terminal sessions.

This makes the current flow fragile:

1. user runs `agentinbox agent list`
2. user copies an `agentId`
3. user performs inbox/subscription operations with that `agentId`

This is easy to mis-target when:

- multiple iTerm windows are open
- multiple tmux panes are active
- multiple Codex / Claude Code sessions are registered

In practice, this can route inbox actions and notifications to the wrong
terminal target.

## Goals

- make the current session the default target for session-bound agent workflows
- keep detached/webhook agents operable by explicit `--agent`
- surface cross-session risk without turning the CLI into a strict ACL system
- keep CLI output JSON-first and machine-readable

## Non-Goals

- do not introduce a hard authorization model between agents
- do not prohibit intentional cross-agent management
- do not require every caller to pass an `agentId` explicitly

## Terms

### Session-Bound Agent

An agent with a terminal/runtime identity tied to the current interactive
session, such as:

- tmux pane
- iTerm session
- Codex / Claude runtime session

These agents can be resolved from local execution context.

### Detached Agent

An agent without a current terminal-bound session context, such as:

- webhook-only agents
- server-side/background workers
- agents managed remotely or by explicit stable `agentId`

These agents should be operated explicitly by `--agent`.

### Current Agent

The agent that matches the current execution context.

Preferred matching order:

1. terminal identity
   - tmux pane id
   - iTerm session id
   - tty
2. runtime identity
   - `runtimeKind + runtimeSessionId`

## Proposed CLI Behavior

## 1. Add `agent current`

Add:

```bash
agentinbox agent current
```

Behavior:

- if the current terminal/runtime context resolves to a registered agent,
  return it
- otherwise, return a clear error describing that no current agent is
  registered

Suggested JSON response:

```json
{
  "agentId": "agent_codex_...",
  "bindingKind": "session_bound",
  "matchesCurrentTerminal": true,
  "matchesCurrentRuntime": true,
  "terminalIdentity": "iterm2:4B4CB6B2-A73B-4420-94A7-BD2CA216A285"
}
```

## 2. Default To Current Agent For Session Workflows

For agent-scoped commands used from an interactive terminal session, the CLI
should resolve the current agent when `--agent` is omitted.

Examples:

```bash
agentinbox inbox read
agentinbox inbox ack --through <itemId>
agentinbox inbox watch
agentinbox subscription add <sourceId> --filter-json ...
```

Meaning:

- if a current session-bound agent exists, use it
- if not, attempt auto-register when the command is eligible
- if current resolution and auto-register both fail, return an error

### Explicit Agent Override

Still support:

```bash
agentinbox inbox read --agent <agentId>
agentinbox subscription add --agent <agentId> <sourceId>
```

This is the primary path for detached agents.

## 3. Auto-Register For Current-Session Paths

If:

- no `--agent` is provided
- the command is a current-session workflow
- the current session context is registrable
- no current agent is already registered

then the CLI should auto-register the current session before executing the
command.

This should apply to commands such as:

- `inbox read`
- `inbox ack`
- `inbox watch`
- `subscription add`

This should not apply to:

- `agent remove`
- commands with explicit `--agent`
- detached/webhook-only workflows
- batch/admin workflows

Suggested JSON response extension:

```json
{
  "agentId": "agent_codex_...",
  "autoRegistered": true
}
```

## 4. Cross-Session Operations Should Warn, Not Fail

When the caller explicitly passes `--agent`, and:

- the current session resolves to one session-bound agent
- the requested `agentId` is another session-bound agent

the CLI should still execute the command, but return a structured warning.

This is not a hard permission boundary. It is a risk signal.

### Why warning, not error

- there are valid cases where one session intentionally manages another agent
- detached/webhook agents must remain easy to operate
- turning this into a hard failure would overfit a coordination problem into an
  ACL model

## 5. Warnings Must Be JSON-Structured

CLI output is JSON-first, so warnings should be returned in-band instead of
only being printed to stderr.

Suggested shape:

```json
{
  "subscriptionId": "sub_xxx",
  "warnings": [
    {
      "code": "cross_session_agent",
      "message": "Requested agent does not match the current terminal session.",
      "currentAgentId": "agent_a",
      "requestedAgentId": "agent_b"
    }
  ]
}
```

Rules:

- successful commands with warnings still exit with code `0`
- warnings are advisory, not fatal
- commands that truly cannot determine a target should return a normal error

## 6. Detached Agents Should Not Be Penalized

Cross-session warnings should only fire when the requested agent is another
session-bound agent.

Detached agents should remain operable through explicit `--agent` without being
treated as suspicious by default.

That means current-session safety logic must distinguish:

- `session_bound`
- `detached`

The CLI should not assume everything must map to a current terminal.

## Suggested Command Policy

### Current-session default

- `agentinbox inbox read`
- `agentinbox inbox ack ...`
- `agentinbox inbox watch`
- `agentinbox subscription add <sourceId>`

### Explicit detached management

- `agentinbox ... --agent <agentId>`

### Discovery

- `agentinbox agent current`
- `agentinbox agent list`

`agent list` should ideally expose:

- whether the agent is session-bound or detached
- whether it matches the current session
- terminal/runtime identity summaries when relevant

## Acceptance Criteria

- users can reliably discover which agent belongs to the current session
- common interactive commands no longer require copying `agentId`
- detached agents remain easy to operate explicitly
- cross-session risk is visible in structured CLI output
- no current-session workflow silently targets the wrong agent when a current
  agent can be resolved

## Notes

This RFC intentionally does not define a hard authorization or ownership model.
It defines safer defaults and structured warnings for a local multi-session
operator experience.
