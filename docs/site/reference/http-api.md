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

## Sources

- `GET /sources`
- `POST /sources`
- `GET /sources/{sourceId}`
- `GET /sources/{sourceId}/schema`
- `POST /sources/schema-preview`
- `PATCH /sources/{sourceId}`
- `DELETE /sources/{sourceId}`
- `POST /sources/{sourceId}/pause`
- `POST /sources/{sourceId}/resume`
- `GET /source-types/{sourceType}/schema`
- `POST /sources/{sourceId}/poll`
- `POST /sources/{sourceId}/events`

## Agents

- `GET /agents`
- `POST /agents`
- `GET /agents/{agentId}`
- `DELETE /agents/{agentId}`

## Activation Targets

- `GET /agents/{agentId}/targets`
- `POST /agents/{agentId}/targets`
- `DELETE /agents/{agentId}/targets/{targetId}`

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
  "agentId": "agent_...",
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
{ "throughItemId": "item_..." }
```

```json
{ "itemIds": ["item_..."] }
```

```json
{ "all": true }
```

## Notes

- The OpenAPI contract is generated from the same Fastify route schemas used for
  runtime validation and is served at `GET /openapi.json`.

- `local_event` is the only source type that supports direct manual append through
  `POST /sources/{sourceId}/events`.
- `remote_source` is supported and requires `config.profilePath` (and optional
  `config.profileConfig`) when registering.
- `POST /sources/schema-preview` previews resolved schema without persisting a
  source. It accepts `sourceRef` plus optional `config` and `configRef`. For a
  user-defined remote implementation, use either `remote_source` with
  `config.profilePath`, or `remote:<moduleId>` with the same config payload.
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
