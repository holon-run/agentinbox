# Source Types

`AgentInbox` v1 uses a host + stream model.

- a host owns shared provider/runtime configuration
- a source/stream binds one concrete feed under that host
- subscriptions stay agent-specific

## Host Types

## `local_event`

`local_event` is the local ingress host. Its canonical stream kind is:

- `events`

Use it when a local producer wants to append events directly into `AgentInbox`
without building a provider-specific adapter first.

## `github`

`github` is the shared GitHub host. Common stream kinds are:

- `repo_events`
- `ci_runs`

Use `repo_events` for issues, issue comments, pull requests, review comments,
and general collaboration activity. Use `ci_runs` for GitHub Actions workflow
state transitions.

Typical canonical registration flow:

```bash
agentinbox host add github uxcAuth:github-default \
  --config-json '{"uxcAuth":"github-default"}'
agentinbox source add <host_id> repo_events holon-run/agentinbox \
  --config-json '{"owner":"holon-run","repo":"agentinbox"}'
agentinbox source add <host_id> ci_runs holon-run/agentinbox \
  --config-json '{"owner":"holon-run","repo":"agentinbox","pollIntervalSecs":30}'
```

Useful normalized `ci_runs` metadata includes:

- `status`
- `conclusion`
- `name`
- `headBranch`
- `headSha`
- `actor`

Typical `ci_runs` subscription filters:

```json
{"status":"completed"}
```

```json
{"status":"completed","conclusion":"failure"}
```

## `feishu`

`feishu` is the shared Feishu host. Its canonical stream kind is:

- `message_events`

It uses `uxc` long-connection subscriptions for inbound messages and `uxc`
OpenAPI delivery for replies.

## `remote_source`

`remote_source` is the generic host type for custom local modules. Its default
stream kind is:

- `default`

It uses a local module to define:

- managed source spec (`source.ensure`)
- raw event mapping (`stream.read` payload -> AgentInbox event)
- config validation

It may also optionally define capability introspection hooks used by resolved
instance schema discovery:

- `describeCapabilities`
- `listSubscriptionShortcuts`
- `expandSubscriptionShortcut`
- `deriveTrackedResource`
- `projectLifecycleSignal`

Configuration fields:

- `modulePath` (required): path under `$AGENTINBOX_HOME/source-modules`
- `moduleConfig` (optional): module-specific config object

## Resolved Stream Schema

After creating a source/stream, inspect its resolved schema before adding
subscriptions:

```bash
agentinbox source schema <source_id>
```

Builtin GitHub and Feishu streams still expose source-specific metadata fields,
payload examples, shortcuts, and lifecycle hooks through the resolved source
schema. The canonical registration path is the host + stream flow above, not
the old pre-v1 source-kind aliases.
