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
- `DELETE /sources/{sourceId}`
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

## Inbox

- `GET /agents/{agentId}/inbox`
- `GET /agents/{agentId}/inbox/items`
- `GET /agents/{agentId}/inbox/watch`
- `POST /agents/{agentId}/inbox/ack`
- `POST /agents/{agentId}/inbox/compact`

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
