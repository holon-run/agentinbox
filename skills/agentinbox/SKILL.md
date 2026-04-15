---
name: agentinbox
description: Use the local AgentInbox service to onboard the current session, manage shared sources and subscriptions, connect external providers such as GitHub through UXC, and operate the agent inbox.
metadata:
  short-description: Operate AgentInbox sources and subscriptions
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

UXC repository:

- `https://github.com/holon-run/uxc`

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

This `gh` import path requires `uxc` 0.15.0 or newer.

Register the current terminal/runtime session:

```bash
agentinbox agent register
```

Treat the returned `agentId` as the stable identity for later commands.

## Usage Discipline

When operating AgentInbox, follow these defaults unless there is a strong reason
not to:

1. prefer broad reusable sources and narrow subscriptions
2. remove subscriptions when they are no longer needed

In practice:

- do not create one GitHub source per PR unless the source itself must be PR-
  scoped
- prefer one shared repo or repo-CI source and use subscription filters for PR,
  branch, workflow, or failure-specific routing
- if a source exposes subscription shortcuts, prefer the shortcut over manually
  reconstructing the same filter and lifecycle fields
- treat unused task-specific subscriptions as cleanup debt and remove them when
  the task is done
- if GitHub polling volume looks high, inspect old subscriptions and duplicate
  temporary sources before adding more

This matches the AgentInbox model: sources are shared hosting units, while
subscriptions carry agent-specific filtering and delivery intent.

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
agentinbox source schema <sourceId>
agentinbox subscription add <sourceId>
agentinbox subscription add <sourceId> --agent-id <agentId>
agentinbox subscription add <sourceId> --shortcut pr --shortcut-args-json '{"number":87}'
agentinbox subscription add <sourceId> --filter-json '{"metadata":{"headBranch":"main","conclusion":"failure"}}'
agentinbox subscription list --agent-id <agentId>
agentinbox subscription show <subscriptionId>
agentinbox subscription poll <subscriptionId>
agentinbox subscription remove <subscriptionId>
```

Use `source schema` before adding task-scoped subscriptions for remote-backed
sources. If `subscriptionSchema.shortcuts` is non-empty, prefer those shortcut
entries first. They are easier to reuse and let the source own any matching
tracked-resource and cleanup-policy defaults.

Read and ack the inbox:

```bash
agentinbox inbox read
agentinbox inbox read --agent-id <agentId>
agentinbox inbox ack --agent-id <agentId> --through <lastItemId>
agentinbox inbox watch
agentinbox inbox watch --agent-id <agentId>
agentinbox inbox ack --all
agentinbox inbox ack --agent-id <agentId> --all
```

Default to a batch-bounded ack flow:

1. read the inbox items you intend to process
2. identify the last item you actually reviewed in that batch
3. ack with `--through <lastItemId>`

Use `ack --all` only when you have explicitly verified that every current
unacked item should be cleared and there is no need to preserve the reviewed
batch boundary. Otherwise it can clear items that arrived after the read step
or older pending items you did not intend to acknowledge yet.

Manage activation targets:

```bash
agentinbox agent target list <agentId>
agentinbox agent target add webhook <agentId> --url http://127.0.0.1:8787/webhook
agentinbox agent target remove <agentId> <targetId>
```

For filtering strategy and review workflow setup, follow the docs links above
instead of re-explaining the full architecture here.
