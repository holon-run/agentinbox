---
name: agentinbox
description: Use the local AgentInbox service to register the current agent session, manage sources and subscriptions, read/watch/ack the agent inbox, and inspect activation targets. Use when an agent needs durable local event subscriptions, terminal or webhook activations, or a programmable local event bus.
metadata:
  short-description: Operate the local AgentInbox service
---

# AgentInbox Skill

Use this skill when work should flow through the local `agentinbox` daemon instead of ad hoc polling or one-off webhooks.

`AgentInbox` is the local event subscription and delivery service for agents. It owns:

- agent registration for the current runtime session
- durable source ingestion
- subscription routing
- per-agent inbox read/watch/ack
- activation targets such as terminal injection and webhooks

## First-Run Onboarding

If the user wants to start using `AgentInbox`, this skill should handle the
onboarding flow directly instead of sending the user through a separate wizard.

Recommended first-run sequence:

1. verify `agentinbox` is installed
2. verify the local daemon is running, or start it
3. verify `uxc` is installed when GitHub or Feishu adapters are needed
4. if GitHub access is needed and `gh auth status` is already authenticated, run:

```bash
uxc auth credential import github --from gh
```

5. register the current terminal session:

```bash
agentinbox agent register
```

6. use the docs examples to add the required standing subscriptions

The preferred references are:

- `https://agentinbox.holon.run/guides/onboarding-with-agent-skill`
- `https://agentinbox.holon.run/guides/getting-started`
- `https://agentinbox.holon.run/guides/review-workflows`

## Prerequisites

- `agentinbox` is available in `PATH`
- the local `agentinbox` daemon is running
- the command should succeed:

```bash
agentinbox --version
agentinbox status
```

If `agentinbox status` fails, start the daemon first:

```bash
agentinbox daemon start
```

If GitHub-backed adapters are needed, prefer:

```bash
uxc --version
gh auth status
uxc auth credential import github --from gh
```

This `gh` import path requires `uxc` 0.13.3 or newer.

## Core Workflow

### 1. Register the current agent session

Always start by registering the current terminal/runtime session:

```bash
agentinbox agent register
```

This detects the current runtime and terminal context, creates or refreshes the agent, and returns:

- `agent.agentId`
- `terminalTarget.targetId`
- the derived inbox for that agent

Treat `agentId` as the stable identity for later commands.

### 2. Create or inspect sources

List sources:

```bash
agentinbox source list
```

Show one source:

```bash
agentinbox source show <sourceId>
```

Common source creation patterns:

```bash
agentinbox source add local_event <sourceKey>
agentinbox source add github_repo <owner>/<repo> --config-json '{"owner":"holon-run","repo":"agentinbox","uxcAuth":"github-default","pollIntervalSecs":30}'
agentinbox source add github_repo_ci <owner>/<repo> --config-json '{"owner":"holon-run","repo":"agentinbox","uxcAuth":"github-default","perPage":10}'
```

For `local_event` sources, append events explicitly:

```bash
agentinbox source event <sourceId> --native-id evt_123 --event local.demo --payload-json '{"message":"hello"}'
```

### 3. Subscribe the agent

Create a subscription from a source into the current agent inbox:

```bash
agentinbox subscription add <agentId> <sourceId>
```

With filtering:

```bash
agentinbox subscription add <agentId> <sourceId> --match-json '{"headBranch":"main","conclusion":"failure"}'
```

Inspect subscriptions:

```bash
agentinbox subscription list --agent-id <agentId>
agentinbox subscription show <subscriptionId>
agentinbox subscription lag <subscriptionId>
```

For pull-based sources, poll the source explicitly when needed:

```bash
agentinbox source poll <sourceId>
```

If you need to replay or reposition a subscription:

```bash
agentinbox subscription reset <subscriptionId> --start-policy latest
agentinbox subscription reset <subscriptionId> --start-policy earliest
```

### 4. Read, watch, and ack the agent inbox

The public inbox interface is agent-based. Do not require `inboxId` in normal workflows.

Read:

```bash
agentinbox inbox read <agentId>
```

Watch:

```bash
agentinbox inbox watch <agentId>
```

Ack everything after processing:

```bash
agentinbox inbox ack <agentId> --all
```

Ack one item:

```bash
agentinbox inbox ack <agentId> --item <itemId>
```

### 5. Manage activation targets

List activation targets for the agent:

```bash
agentinbox agent target list <agentId>
```

Add a webhook activation target:

```bash
agentinbox agent target add webhook <agentId> --url http://127.0.0.1:8787/webhook
```

Remove one:

```bash
agentinbox agent target remove <agentId> <targetId>
```

The terminal activation target for the current session is usually created by `agent register`.

## Product Model

Keep these concepts straight:

- `Agent`
  - the public identity for a runtime session
  - owns activation targets
- `Source`
  - where events come from
- `Subscription`
  - routing and filtering from a source into an agent inbox
- `Inbox`
  - public commands use `agentId`
  - the underlying inbox id is an internal detail

Practical rule:

- default to one agent = one inbox
- notifications belong to the agent
- subscriptions route events; they do not own terminal or webhook config

## Recommended Patterns

### Use AgentInbox as a local event bus

When another local tool wants durable events:

1. create a `local_event` source
2. append events with `source event`
3. subscribe one or more agents
4. let agents `watch` or receive activations

### Use watch for continuous consumption

If the current agent process is meant to keep working as new events arrive:

```bash
agentinbox inbox watch <agentId>
```

Use terminal activation as a wake-up path; use inbox watch as the durable read path.

### Ack deliberately

`ack` is the signal that current work is done. Notification gating and repeated terminal activation use ack semantics, so do not ack early.

## Debugging

Check overall daemon state:

```bash
agentinbox status
```

Common checks:

- agent exists:
  - `agentinbox agent show <agentId>`
- source is active:
  - `agentinbox source show <sourceId>`
- subscription is advancing:
  - `agentinbox subscription lag <subscriptionId>`
- inbox contains pending items:
  - `agentinbox inbox read <agentId>`

If notifications are not arriving:

1. confirm `agent register` created a terminal target
2. confirm the source is active and has new stream events
3. confirm the subscription is attached to the right `agentId`
4. confirm the inbox has unacked items
5. confirm the agent has activation targets

## When Not To Use This Skill

Do not use this skill when:

- the task is only about editing local files
- no durable subscription or activation behavior is needed
- the interaction belongs to a different remote interface and should go through a provider-specific skill instead
