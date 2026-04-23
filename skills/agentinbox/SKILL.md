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

## First-Run Onboarding

Recommended first-run sequence:

1. if GitHub access is needed and `gh` is already authenticated, import that auth into `uxc`
2. register the current terminal session
3. follow the required sources or resources using the docs examples

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

Defaults:

- do not create one GitHub source per PR unless the source itself must be PR-
  scoped
- prefer shared repo/repo-CI sources plus narrow follows or subscriptions
- prefer `agentinbox follow` over manual `subscription add` when a follow
  template exists
- if a source exposes only subscription shortcuts, prefer the shortcut over
  manually reconstructing the same filter and lifecycle fields
- treat unused task-specific subscriptions as cleanup debt
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

Lifecycle:

1. register once per live terminal/runtime session
2. reuse broad shared sources
3. add narrow task-scoped follows, subscriptions, or timers
4. read inbox items in bounded batches and ack only the reviewed batch
5. clean up task-scoped subscriptions/timers after merge, closure, or abandonment

For PR and review workflows, prefer `follow` templates. They reuse shared
sources, expand the source-specific filters, and attach cleanup behavior:

```bash
agentinbox agent register
agentinbox follow github pr --agent-id <agentId> --arg owner=holon-run --arg repo=agentinbox --arg number=87 --arg withCi=true
agentinbox inbox read --agent-id <agentId>
agentinbox inbox ack --agent-id <agentId> --through <lastEntryId>
```

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

Follow high-level templates:

```bash
agentinbox follow github repo --agent-id <agentId> --arg owner=holon-run --arg repo=agentinbox
agentinbox follow github pr --agent-id <agentId> --arg owner=holon-run --arg repo=agentinbox --arg number=87 --arg withCi=true
agentinbox follow github issue --agent-id <agentId> --arg owner=holon-run --arg repo=agentinbox --arg number=180
agentinbox follow github pr --agent-id <agentId> --args-json '{"owner":"holon-run","repo":"agentinbox","number":87,"withCi":true}'
```

Use `follow` as the default path for GitHub repo, PR, and issue tracking. Drop
to `source schema` plus `subscription add` only when you need a custom filter or
the source has no follow template.

Advanced source/subscription commands:

```bash
agentinbox source list
agentinbox source show <sourceId>
agentinbox source schema <sourceId>
agentinbox source add <hostId> repo_events <owner>/<repo> --config-json '{"owner":"holon-run","repo":"agentinbox"}'
agentinbox source add <hostId> ci_runs <owner>/<repo> --config-json '{"owner":"holon-run","repo":"agentinbox","pollIntervalSecs":30}'
agentinbox subscription add <sourceId> --shortcut pr --shortcut-args-json '{"number":87}'
agentinbox subscription add <sourceId> --filter-json '{"metadata":{"headBranch":"main","conclusion":"failure"}}'
agentinbox subscription list --agent-id <agentId>
agentinbox subscription remove <subscriptionId>
```

Use manual subscriptions for advanced filters, custom source kinds, or when
debugging template expansion. If `subscriptionSchema.shortcuts` is non-empty
but no follow template is available, prefer those shortcut entries first.

Read and ack the inbox:

```bash
agentinbox inbox read --agent-id <agentId>
agentinbox inbox ack --agent-id <agentId> --through <lastEntryId>
agentinbox inbox send --agent-id <agentId> --message "Please review PR #87"
agentinbox inbox watch --agent-id <agentId>
agentinbox inbox ack --agent-id <agentId> --all
```

Default to a batch-bounded ack flow:

1. read the inbox items you intend to process
2. identify the last item you actually reviewed in that batch
3. ack with `--through <lastEntryId>`

Use `ack --all` only after explicitly verifying every current item should be
cleared. Use `inbox send` for local operator/direct text ingress.

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

Activation targets:

```bash
agentinbox agent target list <agentId>
agentinbox agent target add webhook <agentId> --url http://127.0.0.1:8787/webhook
agentinbox agent target remove <agentId> <targetId>
```

For filtering strategy and review workflow setup, follow the docs links above
instead of re-explaining the full architecture here.

## Troubleshooting

Do not start every task by checking daemon status; normal CLI commands should
auto-connect or surface actionable errors. Use these checks after the first
AgentInbox command fails, notifications stop arriving, or you suspect a stale
terminal binding:

```bash
agentinbox --version
agentinbox daemon status
agentinbox daemon start
agentinbox agent register --agent-id <agentId> --force-rebind
```

If GitHub-backed sources fail, verify UXC and imported GitHub auth only after
the failure points there:

```bash
uxc --version
gh auth status
uxc auth credential import github --from gh
```
