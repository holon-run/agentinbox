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
agentinbox source remove <source_id>
agentinbox source schema <source_type>
agentinbox source poll <source_id>
agentinbox source event <source_id> --native-id <id> --event <variant>
```

## Subscriptions

```bash
agentinbox subscription add <source_id> [--agent-id <agent_id>] [--filter-json ...]
agentinbox subscription add <source_id> [--agent-id <agent_id>] --filter-file <path>
agentinbox subscription add <source_id> [--agent-id <agent_id>] --filter-stdin
agentinbox subscription list [--agent-id <agent_id>] [--source-id <source_id>]
agentinbox subscription show <subscription_id>
agentinbox subscription remove <subscription_id>
agentinbox subscription lag <subscription_id>
agentinbox subscription reset <subscription_id> --start-policy latest
```

`subscription add` accepts exactly one of `--filter-json`, `--filter-file`, or
`--filter-stdin`. The created subscription response echoes the normalized
persisted `filter`.

## Inbox

Inbox commands use `agentId`, not `inboxId`.

```bash
agentinbox inbox show <agent_id>
agentinbox inbox read [--agent-id <agent_id>]
agentinbox inbox watch [--agent-id <agent_id>]
agentinbox inbox ack [--agent-id <agent_id>] --through <item_id>
agentinbox inbox ack [--agent-id <agent_id>] --item <item_id>
agentinbox inbox ack [--agent-id <agent_id>] --all
agentinbox inbox compact <agent_id>
```

## Maintenance

```bash
agentinbox gc
agentinbox status
```

## HTTP API

See [HTTP API](./http-api.md) for the stable control-plane endpoints.
