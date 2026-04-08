# Getting Started

This guide shows the shortest path from install to a working local agent
session.

## Prerequisites

- Node.js 20 or newer
- `uxc` if you want to use GitHub or Feishu source adapters

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
```

This detects the current runtime and terminal context, assigns or restores an
`agentId`, creates the agent inbox, and attaches a terminal activation target.

## Local Event Flow

The shortest end-to-end flow is a local source:

```bash
agentinbox source add local_event local-demo
agentinbox subscription add <agent_id> <source_id>
agentinbox source event <source_id> \
  --native-id demo-1 \
  --event local.demo \
  --metadata-json '{"channel":"engineering"}' \
  --payload-json '{"text":"hello from a local producer"}'
agentinbox inbox read <agent_id>
```

## GitHub Repo CI Example

```bash
agentinbox source add github_repo_ci holon-run/agentinbox \
  --config-json '{"owner":"holon-run","repo":"agentinbox","uxcAuth":"github-default","pollIntervalSecs":30}'
agentinbox subscription add <agent_id> <source_id> \
  --match-json '{"status":"completed","conclusion":"failure","headBranch":"main"}'
agentinbox source poll <source_id>
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
