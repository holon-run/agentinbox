# HTTP API

`AgentInbox` exposes a local control-plane HTTP API over either:

- a Unix domain socket
- a loopback TCP port when started with `serve --port`

The HTTP surface is now resource-oriented and is intended to remain stable
going forward.

## Meta

- `GET /healthz`
- `GET /status`
- `GET /openapi.json`
- `POST /gc`

## Hosts

- `GET /hosts`
- `POST /hosts`
- `GET /hosts/{hostId}`
- `GET /hosts/{hostId}/schema`

`POST /hosts` accepts the shared provider/runtime host configuration:

```json
{
  "hostType": "github",
  "hostKey": "uxcAuth:github-default",
  "config": {
    "uxcAuth": "github-default"
  }
}
```

## Streams / Sources

- `GET /sources`
- `POST /sources`
- `GET /sources/{sourceId}`
- `GET /sources/{sourceId}/schema`
- `PATCH /sources/{sourceId}`
- `DELETE /sources/{sourceId}`
- `POST /sources/{sourceId}/pause`
- `POST /sources/{sourceId}/resume`
- `POST /sources/{sourceId}/poll`
- `POST /sources/{sourceId}/events`

The canonical registration shape is host+stream:

```json
{
  "hostId": "hst_...",
  "streamKind": "repo_events",
  "streamKey": "holon-run/agentinbox",
  "config": {
    "owner": "holon-run",
    "repo": "agentinbox"
  }
}
```

`POST /sources` is the stream-oriented creation endpoint. `GET /sources/{sourceId}`
and related routes continue to operate on stream/source instances after
registration.

## Agents

- `GET /agents`
- `POST /agents`
- `GET /agents/{agentId}`
- `DELETE /agents/{agentId}`

## Activation Targets

- `GET /agents/{agentId}/targets`
- `POST /agents/{agentId}/targets`
- `DELETE /agents/{agentId}/targets/{targetId}`

## Timers

- `GET /timers`
- `POST /timers`
- `POST /timers/{scheduleId}/pause`
- `POST /timers/{scheduleId}/resume`
- `DELETE /timers/{scheduleId}`

`POST /timers` accepts a narrow reminder body:

```json
{
  "agentId": "agt_...",
  "at": "2026-04-15T08:00:00+08:00",
  "message": "Analyze the agentinbox project and prepare today's task plan.",
  "sender": "timer"
}
```

Use exactly one of `at`, `every`, or `cron`. `every` is an interval in milliseconds. `timezone` is optional and defaults to the daemon host timezone.

## Subscriptions

- `GET /subscriptions`
- `POST /subscriptions`
- `GET /subscriptions/{subscriptionId}`
- `DELETE /subscriptions/{subscriptionId}`
- `POST /subscriptions/{subscriptionId}/poll`
- `GET /subscriptions/{subscriptionId}/lag`
- `POST /subscriptions/{subscriptionId}/reset`

`POST /subscriptions` accepts:

```json
{
  "agentId": "agt_...",
  "sourceId": "src_...",
  "filter": {},
  "trackedResourceRef": "pr:373",
  "cleanupPolicy": {
    "mode": "on_terminal_or_at",
    "at": "2026-05-01T00:00:00.000Z",
    "gracePeriodSecs": 300
  }
}
```

`cleanupPolicy` defaults to `{"mode":"manual"}` when omitted.

`POST /subscriptions` always returns an envelope:

```json
{
  "subscriptions": [
    {
      "subscriptionId": "sub_...",
      "agentId": "agt_...",
      "sourceId": "src_..."
    }
  ]
}
```

Non-shortcut creation returns one element. A shortcut may expand into multiple
subscriptions, so callers should always read `subscriptions[]`.

## Inbox

- `GET /agents/{agentId}/inbox`
- `GET /agents/{agentId}/inbox/items`
- `POST /agents/{agentId}/inbox/items`
- `GET /agents/{agentId}/inbox/watch`
- `POST /agents/{agentId}/inbox/ack`
- `POST /agents/{agentId}/inbox/compact`

`POST /agents/{agentId}/inbox/items` accepts a narrow direct-text ingress body:

```json
{
  "message": "Review PR #51 CI failure and push a fix.",
  "sender": "local-script"
}
```

`message` is required. `sender` is optional.

`POST /agents/{agentId}/inbox/ack` accepts exactly one of:

```json
{ "throughEntryId": "ent_..." }
```

```json
{ "entryIds": ["ent_..."] }
```

```json
{ "all": true }
```

## Notes

- The OpenAPI contract is generated from the same Fastify route schemas used for
  runtime validation and is served at `GET /openapi.json`.

- `local_event` is the only source type that supports direct manual append through
  `POST /sources/{sourceId}/events`.
- `remote_source` is supported and requires `config.modulePath` (and optional
  `config.moduleConfig`) on the stream/source config when registering.
- `PATCH /sources/{sourceId}` updates persisted `config` and/or `configRef`
  without changing the `sourceId` or existing subscriptions. Active/error
  sources are re-ensured after update; paused sources keep their paused
  lifecycle state until explicitly resumed.
- `POST /sources/{sourceId}/pause` and `POST /sources/{sourceId}/resume` apply
  only to managed remote sources. Pause stops the managed runtime without
  deleting its binding or stream state. Resume re-enters the normal ensure
  path. `POST /sources/{sourceId}/poll` does not implicitly resume a paused
  source.
- `GET /sources/{sourceId}` may include `idleState` for managed remote sources
  that are waiting for auto-pause or were auto-paused after their last
  subscription was removed.
