---
name: agentinbox
description: Use the local AgentInbox service to onboard the current session, connect GitHub through UXC, and operate sources, subscriptions, and the agent inbox.
metadata:
  short-description: Operate the local AgentInbox service
---

# AgentInbox Skill

Use this skill when the current agent should set up or use the local
`agentinbox` daemon.

Primary docs:

- `https://agentinbox.holon.run/guides/onboarding-with-agent-skill`
- `https://agentinbox.holon.run/guides/getting-started`
- `https://agentinbox.holon.run/guides/review-workflows`
- `https://agentinbox.holon.run/reference/cli`

## Install

Install `agentinbox` if it is not already available:

```bash
npm install -g @holon-run/agentinbox
```

Install `uxc` if GitHub or Feishu adapters are needed:

```bash
brew tap holon-run/homebrew-tap
brew install uxc
```

Then verify:

```bash
agentinbox --version
uxc --version
```

## First-Run Onboarding

Recommended first-run sequence:

1. start or verify the local daemon
2. if GitHub access is needed and `gh` is already authenticated, import that auth into `uxc`
3. register the current terminal session
4. add the required sources and subscriptions using the docs examples

Start or verify the daemon:

```bash
agentinbox daemon start
agentinbox daemon status
```

If GitHub-backed adapters are needed:

```bash
gh auth status
uxc auth credential import github --from gh
```

This `gh` import path requires `uxc` 0.13.3 or newer.

Register the current terminal/runtime session:

```bash
agentinbox agent register
```

Treat the returned `agentId` as the stable identity for later commands.

## Core Commands

Create or inspect sources:

```bash
agentinbox source list
agentinbox source show <sourceId>
agentinbox source add local_event <sourceKey>
agentinbox source add github_repo <owner>/<repo> --config-json '{"owner":"holon-run","repo":"agentinbox","uxcAuth":"github-default","pollIntervalSecs":30}'
agentinbox source add github_repo_ci <owner>/<repo> --config-json '{"owner":"holon-run","repo":"agentinbox","uxcAuth":"github-default","perPage":10}'
```

Append a local event:

```bash
agentinbox source event <sourceId> --native-id evt_123 --event local.demo --payload-json '{"message":"hello"}'
```

Add or inspect subscriptions:

```bash
agentinbox subscription add <agentId> <sourceId>
agentinbox subscription add <agentId> <sourceId> --match-json '{"headBranch":"main","conclusion":"failure"}'
agentinbox subscription list --agent-id <agentId>
agentinbox subscription show <subscriptionId>
agentinbox subscription remove <subscriptionId>
```

Read and ack the inbox:

```bash
agentinbox inbox read <agentId>
agentinbox inbox watch <agentId>
agentinbox inbox ack <agentId> --all
```

Manage activation targets:

```bash
agentinbox agent target list <agentId>
agentinbox agent target add webhook <agentId> --url http://127.0.0.1:8787/webhook
agentinbox agent target remove <agentId> <targetId>
```

For filtering strategy and review workflow setup, follow the docs links above
instead of re-explaining the full architecture here.
