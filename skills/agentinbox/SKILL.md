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

This `gh` import path requires `uxc` 0.15.3 or newer.

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

## Default Async Lifecycle

Default to AgentInbox when the work is not purely synchronous in the current
session.

Typical cases:

- delayed follow-up that should happen after you stop actively looking at the
  terminal
- waiting for PR review, CI completion, issue replies, or other external
  events
- anything that must survive session boundaries instead of living only in chat
  memory
- reminders that should fire at a specific time or on a recurring schedule

For this kind of work, treat AgentInbox as the durable tracking layer and use a
consistent lifecycle:

Important boundary:

- inbox items, subscriptions, and timers can outlive the current terminal
  session
- terminal delivery does not automatically survive session boundaries just
  because the inbox state does
- if the original runtime/terminal disappears, items may keep accumulating in
  the inbox while notifications stop reaching you
- if a later session should resume the same logical agent, re-register or
  explicitly rebind that agent to the current terminal before assuming prompt
  delivery is live again

For example, resuming the same logical agent in a later session may look like:

```bash
agentinbox agent register --agent-id <agentId> --force-rebind
```

1. register the current terminal session and keep the returned `agentId`
2. reuse broad shared sources when they already exist
3. add narrow task-scoped subscriptions or timers for the specific PR, issue,
   branch, or workflow you care about
4. read inbox items in bounded batches, process them, and ack only the batch
   you actually reviewed
5. clean up task-scoped subscriptions or timers after merge, closure,
   abandonment, or any other terminal state

For PR and review workflows, prefer one shared repo source and one shared
repo-CI source, then add PR-scoped subscriptions on top:

```bash
agentinbox agent register
agentinbox source schema <sourceId>
agentinbox subscription add <sourceId> --agent-id <agentId> --shortcut pr --shortcut-args-json '{"number":87,"withCi":true}'
agentinbox inbox read --agent-id <agentId>
agentinbox inbox ack --agent-id <agentId> --through <lastEntryId>
agentinbox subscription list --agent-id <agentId>
agentinbox subscription remove <subscriptionId>
```

That flow should be read as:

- register once per live terminal/runtime session
- prefer shortcut-driven PR subscriptions when the source exposes them
- let review comments, review decisions, PR state changes, and CI updates
  arrive through the inbox
- after the PR is merged, closed, or abandoned, verify that task-scoped
  subscriptions are gone and remove any leftovers

Cleanup expectations:

- subscriptions are task assets by default, not permanent infrastructure
- if a task-specific subscription is no longer serving an active task, remove
  it
- if polling-backed GitHub setup starts to accumulate, inspect old
  subscriptions before creating more
- auto-retiring cleanup policies reduce cleanup debt, but they do not remove
  the need to verify the task is fully cleaned up

Ack discipline:

- prefer `agentinbox inbox ack --agent-id <agentId> --through <lastEntryId>`
  after reading a reviewed batch
- avoid `ack --all` unless you explicitly verified that every current item
  should be cleared
- do not ack speculative future work just because the current terminal message
  was seen

Timer intent:

- use `agentinbox timer add` when the trigger is time-based rather than source-based
- prefer timers over inventing fake local events for reminders like "check CI
  in 30 minutes" or "revisit this PR tomorrow morning"

## Core Commands

Create or inspect sources:

```bash
agentinbox host list
agentinbox host show <hostId>
agentinbox host add local_event local-demo
agentinbox host add github uxcAuth:github-default --config-json '{"uxcAuth":"github-default"}'
agentinbox source list
agentinbox source show <sourceId>
agentinbox source add <hostId> events local-demo
agentinbox source add <hostId> repo_events <owner>/<repo> --config-json '{"owner":"holon-run","repo":"agentinbox"}'
agentinbox source add <hostId> ci_runs <owner>/<repo> --config-json '{"owner":"holon-run","repo":"agentinbox","pollIntervalSecs":30}'
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
agentinbox inbox ack --agent-id <agentId> --through <lastEntryId>
agentinbox inbox send --agent-id <agentId> --message "Please review PR #87"
agentinbox inbox send --agent-id <agentId> --message "CI failed on main" --sender operator
agentinbox inbox watch
agentinbox inbox watch --agent-id <agentId>
agentinbox inbox ack --all
agentinbox inbox ack --agent-id <agentId> --all
```

Default to a batch-bounded ack flow:

1. read the inbox items you intend to process
2. identify the last item you actually reviewed in that batch
3. ack with `--through <lastEntryId>`

Use `ack --all` only when you have explicitly verified that every current
unacked item should be cleared and there is no need to preserve the reviewed
batch boundary. Otherwise it can clear items that arrived after the read step
or older pending items you did not intend to acknowledge yet.

Use `inbox send` as the default local operator path for direct text ingress when
you want to place a human-written or agent-written message into an inbox
without creating a source event or calling the HTTP control plane directly.

Manage timers:

```bash
agentinbox timer add --agent-id <agentId> --at <RFC3339_TIMESTAMP> --message "Check the morning build"
agentinbox timer add --agent-id <agentId> --every 24h --message "Review today's open PRs"
agentinbox timer add --agent-id <agentId> --cron "0 8 * * *" --timezone Asia/Shanghai --message "Daily triage"
agentinbox timer list
agentinbox timer list --agent-id <agentId>
agentinbox timer pause <scheduleId>
agentinbox timer resume <scheduleId>
agentinbox timer remove <scheduleId>
```

Use timers when the need is time-based rather than source-based. Prefer them
over local event workarounds for reminders, recurring check-ins, and scheduled
follow-ups.

Manage activation targets:

```bash
agentinbox agent target list <agentId>
agentinbox agent target add webhook <agentId> --url http://127.0.0.1:8787/webhook
agentinbox agent target remove <agentId> <targetId>
```

For filtering strategy and review workflow setup, follow the docs links above
instead of re-explaining the full architecture here.
