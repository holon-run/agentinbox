# CLI Reference

`AgentInbox` uses a local control-plane CLI around agents, sources,
subscriptions, inboxes, activation targets, and daemon lifecycle.

## Meta Commands

Text-first commands:

```bash
agentinbox --help
agentinbox help inbox
agentinbox --version
```

Resource and control-plane commands return JSON by default.

## Daemon

```bash
agentinbox daemon start
agentinbox daemon stop
agentinbox daemon status
```

`daemon status` returns machine-readable JSON including the daemon PID,
transport, and runtime metadata such as the running `version`, `startedAt`,
`command`, and `nodeVersion` when they can be determined locally.

## Agent

```bash
agentinbox agent register [--agent-id ID] [--force-rebind]
agentinbox agent list
agentinbox agent current
agentinbox agent show <agent_id>
agentinbox agent remove <agent_id>
```

## Sources

```bash
agentinbox source add <source_type> <source_key> [--config-json ...]
agentinbox source list
agentinbox source show <source_id>
agentinbox source update <source_id> [--config-json ...] [--config-ref ...]
agentinbox source remove <source_id>
agentinbox source pause <remote_source_id>
agentinbox source resume <remote_source_id>
agentinbox source schema <source_id|source_type>
agentinbox source schema preview <source_kind|source_type> [--config-json ...] [--config-ref ...]
agentinbox source poll <source_id>
agentinbox source event <source_id> --native-id <id> --event <variant>
```

`source pause` and `source resume` apply only to managed remote sources. Pause
stops the managed runtime without deleting its binding or stream checkpoint.
Resume goes back through the normal ensure path. Manual `source poll` does not
resume a paused source.

`source update` replaces persisted `config` and/or `configRef` in place while
preserving the existing `sourceId` and attached subscriptions.

`source schema preview` resolves a schema before source registration. Builtin
remote-backed kinds can be previewed directly, for example `github_repo`.
User-defined remote modules can be previewed with either `remote_source` or
`remote:<moduleId>` plus `--config-json '{"profilePath":"...","profileConfig":{}}'`.

Managed remote sources now auto-pause after a grace period once their last
subscription is removed. `source show <sourceId>` includes `idleState` when a
source is idle or was auto-paused for idleness.

## Subscriptions

```bash
agentinbox subscription add <source_id> [--agent-id <agent_id>] [--filter-json ...] [--tracked-resource-ref <ref>] [--cleanup-policy-json <json>]
agentinbox subscription add <source_id> [--agent-id <agent_id>] --filter-file <path> [--tracked-resource-ref <ref>] [--cleanup-policy-json <json>]
agentinbox subscription add <source_id> [--agent-id <agent_id>] --filter-stdin [--tracked-resource-ref <ref>] [--cleanup-policy-json <json>]
agentinbox subscription add <source_id> [--agent-id <agent_id>] --shortcut <name> [--shortcut-args-json <json>]
agentinbox subscription list [--agent-id <agent_id>] [--source-id <source_id>]
agentinbox subscription show <subscription_id>
agentinbox subscription remove <subscription_id>
agentinbox subscription poll <subscription_id>
agentinbox subscription lag <subscription_id>
agentinbox subscription reset <subscription_id> --start-policy latest
```

`subscription add` accepts exactly one of `--filter-json`, `--filter-file`, or
`--filter-stdin`. The created subscription response echoes the normalized
persisted `filter`. When any explicit filter input mode is selected
(`--filter-json`, `--filter-file`, or `--filter-stdin`), the supplied payload
must be a non-empty JSON object.

`--shortcut` asks the source implementation to expand a named subscription
shortcut into the standard persisted fields. Use `agentinbox source schema
<source_id>` first to discover whether the source exposes any shortcuts and what
arguments they require. When `--shortcut` is present, do not also pass
`--filter-*`, `--tracked-resource-ref`, or `--cleanup-policy-json`; the
shortcut owns those fields.

`--tracked-resource-ref` persists a source-scoped opaque resource identity such
as `pr:373`. `--cleanup-policy-json` accepts the structured cleanup policy
object persisted with the subscription, for example `{"mode":"manual"}` or
`{"mode":"on_terminal_or_at","at":"2026-05-01T00:00:00.000Z","gracePeriodSecs":300}`.

## Inbox

Inbox commands use `agentId`, not `inboxId`.

```bash
agentinbox inbox list
agentinbox inbox show <agent_id>
agentinbox inbox read [--agent-id <agent_id>]
agentinbox inbox send --agent-id <agent_id> --message "..." [--sender <sender>]
agentinbox inbox watch [--agent-id <agent_id>]
agentinbox inbox ack [--agent-id <agent_id>] --through <item_id>
agentinbox inbox ack [--agent-id <agent_id>] --item <item_id>
agentinbox inbox ack [--agent-id <agent_id>] --all
agentinbox inbox compact <agent_id>
```

## Timers

```bash
agentinbox timer add --agent-id <agent_id> --at 2026-04-15T08:00:00+08:00 --message "..."
agentinbox timer add --agent-id <agent_id> --every 24h --message "..."
agentinbox timer add --agent-id <agent_id> --cron "0 8 * * *" --timezone Asia/Shanghai --message "..."
agentinbox timer list [--agent-id <agent_id>]
agentinbox timer pause <schedule_id>
agentinbox timer resume <schedule_id>
agentinbox timer remove <schedule_id>
```

## Maintenance

```bash
agentinbox gc
agentinbox status
```

## HTTP API

See [HTTP API](./http-api.md) for the stable control-plane endpoints.
