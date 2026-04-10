# Getting Started

This guide shows the shortest path from install to a working local agent
session.

If you are using Codex or Claude Code, start with
[Onboarding With The AgentInbox Skill](./onboarding-with-agent-skill.md). That
is the preferred first-run path.

## Prerequisites

- Node.js 20 or newer
- `uxc` 0.13.3 or newer if you want to use GitHub or Feishu source adapters

Install `AgentInbox` globally:

```bash
npm install -g @holon-run/agentinbox
```

Or run it directly:

```bash
npx @holon-run/agentinbox --help
```

## Daemon

`AgentInbox` runs as a local daemon and stores state in `~/.agentinbox` by
default.

Start it explicitly:

```bash
agentinbox daemon start
```

Inspect it:

```bash
agentinbox daemon status
```

Most CLI commands can auto-start the daemon if it is not already running.

Default paths:

- database: `~/.agentinbox/agentinbox.sqlite`
- socket: `~/.agentinbox/agentinbox.sock`
- log: `~/.agentinbox/agentinbox.log`

## Register The Current Session

Register the current terminal session as an agent:

```bash
agentinbox agent register
agentinbox agent register --agent-id agent-alpha
agentinbox agent current
```

This detects the current runtime and terminal context, assigns or restores an
`agentId`, creates the agent inbox, and attaches a terminal activation target.

If you already use `gh` for GitHub authentication, import it into `uxc` before
adding GitHub-backed sources:

```bash
uxc auth credential import github --from gh
```

## Local Event Flow

The shortest end-to-end flow is a local source:

```bash
agentinbox source add local_event local-demo
agentinbox subscription add <source_id>
agentinbox subscription add <source_id> --agent-id <agent_id>
agentinbox source event <source_id> \
  --native-id demo-1 \
  --event local.demo \
  --metadata-json '{"channel":"engineering"}' \
  --payload-json '{"text":"hello from a local producer"}'
agentinbox inbox read
agentinbox inbox read --agent-id <agent_id>
```

If you need to change an existing source definition without replacing its
subscriptions, update it in place:

```bash
agentinbox source update <source_id> --config-json '{"channel":"infra"}'
agentinbox source update <source_id> --clear-config-ref
```

## GitHub Repo CI Example

```bash
agentinbox source add github_repo_ci holon-run/agentinbox \
  --config-json '{"owner":"holon-run","repo":"agentinbox","uxcAuth":"github-default","pollIntervalSecs":30}'
agentinbox subscription add <source_id> --agent-id <agent_id> \
  --filter-json '{"metadata":{"status":"completed","conclusion":"failure","headBranch":"main"}}'
agentinbox source poll <source_id>
```

For larger filters with nested JSON or JEXL, prefer a file or stdin over shell
quoting:

```bash
agentinbox subscription add <source_id> --filter-file ./filter.json
cat filter.json | agentinbox subscription add <source_id> --filter-stdin
```

If a source already exists and you only need to change its config, update it in
place instead of removing and recreating it:

```bash
agentinbox source update <source_id> \
  --config-json '{"owner":"holon-run","repo":"agentinbox","uxcAuth":"github-default","pollIntervalSecs":60}'
agentinbox source update <source_id> --clear-config-ref
```

For remote-backed sources, use lifecycle commands instead of delete/recreate
when you just want to stop delivery temporarily. These commands do not apply to
`local_event` sources:

```bash
agentinbox source pause <remote_source_id>
agentinbox source poll <remote_source_id>   # returns a paused note, does not resume
agentinbox source resume <remote_source_id>
```

## Terminal Support

- `tmux`
  - most reliable for prompt injection and auto-enter
- `iTerm2`
  - supported for local macOS workflows

## Upgrade Expectations

`AgentInbox` is still early beta software.

- local DB schema and source/runtime semantics may still change between
  versions
- rebuilding local state is an acceptable upgrade path today
- source adapters and filtering semantics are still evolving
