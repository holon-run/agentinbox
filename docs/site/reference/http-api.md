# HTTP API

`AgentInbox` exposes a local control-plane HTTP API over either:

- a Unix domain socket
- a loopback TCP port when started with `serve --port`

The HTTP surface is now resource-oriented and is intended to remain stable
going forward.

## Meta

- `GET /healthz` — returns `{"ok":true,"version":"<daemon build version>"}`.
  `version` is the running daemon's own package version, so clients can
  observe the daemon build instead of their own. Daemons predating #269 omit
  `version`; treat a missing or null `version` as unknown rather than
  assuming it matches the client.
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

`GET /streams/{streamId}` and `GET /sources/{sourceId}` preserve their existing
detail fields and add `streamStats` (`null` when no stream exists).
`eventCount` remains the total number of identity rows, including pruned events;
`replayableEventCount` and `prunedEventCount` distinguish payload availability.
`prunedThroughOffset`, `retainedFromOffset` and `highWatermarkOffset` expose
replay boundaries. The new compaction-specific fields may be absent for
third-party backends.

`POST /streams/{streamId}/compaction-preview` accepts
`{"retentionMs": 2592000000, "scanLimit": 1000}` and performs a bounded,
read-only payload-compaction preview. The path uses the public source/stream ID.
It does not initialize a missing event stream or invoke a provider.
See [CLI preview semantics](cli.md#stream-compaction-preview) for consumer
protection, sample counts, byte estimates and truncation fields.
Invalid durations/limits return 400, missing streams return 404, and a backend
without preview support returns 501. This endpoint cannot apply compaction.

`POST /streams/{streamId}/compaction-apply` is a separate, manual opt-in endpoint:

```json
{"apply": true, "retentionMs": 2592000000, "batchSize": 100, "maxEvents": 1000, "maxPayloadBytes": 8388608}
```

`apply: true` and a positive `retentionMs` are required. The optional limits above
are both defaults and hard upper bounds. Unknown options (including preview-only
`scanLimit`) and missing/false apply return 400; missing streams return 404 and
unsupported backends return 501. No-consumer streams are skipped. Eligibility is
rechecked per short batch; retries skip committed pruned payloads. A single event
over the byte budget blocks progress with `stopReason: oversized`.

Responses report committed batches, pruned logical bytes, replay bounds,
`nextOffset`, `hasMore` and the stop reason. Identity stubs and historical offsets
remain, but payload pruning cannot be undone without a backup. There is no
automatic GC, `VACUUM`, or promise of immediate database-file shrinkage.
See [manual compaction and replay boundaries](cli.md#manual-payload-compaction)
for `latest`, `earliest`, `at_offset`, `at_time`, reset and commit behavior.
History-unavailable failures return 409 with `error`, `code: history_unavailable`,
`streamId`, `requested` (offset/time/startPolicy), `retainedFromOffset`, and
`highWatermarkOffset`; these fields also survive CLI remote errors.

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
- `POST /agents/{agentId}/pause`
- `POST /agents/{agentId}/resume`

`pause` persists `agent.deliveryPaused` independently of aggregation policy and
target offline state. It gates all proactive webhook/terminal notifications,
including digest, retry and timer notifications. Collection, matching, inbox
materialization, reads and explicit outbound replies continue. A request already
started before the pause may finish.

Resume with `{"deliveryOnly":true}` clears this flag and catches up once per effective active
target using persisted unacknowledged entries, without creating inbox entries.
Existing target offline state and retry/defer backoff are preserved. Repeated
resume calls retry due durable pending work, but never replay successfully
notified backlog. Pending catch-up is persisted before clearing the pause, so
request failure or process interruption can be retried by resume or the daemon.
Pause survives daemon restarts.

`deliveryOnly` defaults to false. With an omitted body or `{}`, resume retains
legacy recovery of all offline targets and also clears the delivery pause,
regardless of pause history. Concurrent calls with different scopes are
serialized so target recovery is not lost. Target-level resume only recovers
that target and never clears the agent delivery pause.

## Activation Targets

- `GET /agents/{agentId}/targets`
- `POST /agents/{agentId}/targets`
- `DELETE /agents/{agentId}/targets/{targetId}`
- `POST /agents/{agentId}/targets/{targetId}/resume`

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
