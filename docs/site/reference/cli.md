# CLI Reference

`AgentInbox` uses a local control-plane CLI around agents, sources,
subscriptions, inboxes, activation targets, and daemon lifecycle.

## Stream Compaction Preview

```bash
agentinbox stream compact <streamId> --retention 30d [--dry-run] [--scan-limit 1000]
```

Without `--apply`, this command is **read-only**, including explicit `--dry-run`.
Retention must be explicit and positive (`ms`, `s`, `m`, `h`, `d`, or integer
milliseconds). It never starts a source, creates a consumer, advances an offset,
or changes a payload. No automatic retention policy is installed.

The preview examines at most 1000 events, ordered by the stream's global offsets.
Only a continuous prefix older than the `created_at` cutoff and strictly below
every existing consumer's `nextOffset` is a candidate. Paused/offline consumers
still protect history; no consumers means `no_consumers`, not permission to
compact the whole stream. Acked inbox items are unrelated to this boundary.

Counts and UTF-8 logical field bytes describe the **scanned prefix only**
(`countsScope: scanned_prefix`); `hasMore` / `estimated` indicate a truncated
scan. `candidatePayloadBytes` is not a promise of physical file shrinkage.
`blockingConsumers` lists at most 100 consumers at the minimum offset, with
`blockingConsumersHasMore` indicating truncation. No raw payload is returned.
The command uses the public source/stream ID; the result also identifies the
internal event-log `streamId` and its `sourceId`.

### Manual Payload Compaction

```bash
agentinbox stream compact <streamId> --retention 30d --apply \
  [--batch-size 100] [--max-events 1000] [--max-payload-bytes 8388608]
```

Apply is manual and opt-in. `--apply` conflicts with `--dry-run` and
`--scan-limit`; batch/event/byte limits require `--apply`. Invalid or cross-mode
options fail with status 400. The defaults above are also hard upper bounds.
Eligibility is recalculated inside each short batch transaction; a preview is
not authorization to reuse its candidate set. No consumers means no compaction.
A single event above the per-batch byte budget (at most 8 MiB) stops with
`stopReason: oversized` and `oversizedOffset`, rather than starting an oversized
transaction. Results report committed batches, pruned logical bytes, `hasMore`,
`nextOffset`, and the stopping reason. Repeated invocations skip already pruned
payloads; interrupted runs retain completed batches and roll back unfinished ones.

`blockingConsumers` lists at most 100 consumers at the minimum `nextOffset`;
`blockingConsumersHasMore` indicates truncation. `hasMore` means eligible
candidates remain, including when an oversized event stops progress (reported as
`oversizedOffset`); it does not guarantee another invocation can prune them.
`prunedPayloadBytes` counts original logical bytes of the cleared fields.
The `metadata` and `rawPayload` stubs still hold `{}` (four bytes combined), so
this is neither exact net reclaimed space nor SQLite file savings.

Compaction clears large payload fields but preserves lightweight identity stubs,
timestamps, offsets, deduplication keys and the historical high watermark.
Stubs are never returned as empty normal events. Existing consumers, including
paused/offline ones, protect unread history. After any payload has been pruned:

- `latest` starts at the historical high watermark plus one, even if no payload remains.
- `earliest` fails with `history_unavailable`; explicitly choose `at_offset`
  at or above `retainedFromOffset` to accept the available history.
- `at_offset` below that bound fails; natural global offset gaps remain valid.
- `at_time` fails if any pruned identity has `occurred_at` at or after the
  requested time. The `created_at` retention cutoff is not a replay-time bound.
- Reset, consumer commit and read enforce the same history boundary; they never
  silently clamp an offset or skip pruned history.

History failures exit nonzero and preserve structured `code`, `streamId`,
`requested`, `retainedFromOffset` and `highWatermarkOffset` fields (HTTP 409).
Unsupported backends return 501, not success.

**Pruning is irreversible without a backup.** Disabling further compaction does
not restore payloads. This is logical space reclamation, not immediate SQLite
file shrinkage or bounded identity-row growth. It installs no automatic retention
policy or GC and never runs `VACUUM`.
Do not downgrade a compacted database to a version without replay guards:
older versions do not recognize `payload_pruned_at` and may replay `{}` stubs
as real events. Restore a valid pre-compaction backup before such a downgrade;
turning off apply only stops future pruning and cannot recover history.

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
transport, and runtime metadata such as `startedAt`, `command`, and
`nodeVersion` when they can be determined locally. Version fields:

- `daemonVersion` — the running daemon's build version, self-reported over
  healthz. `null` when the daemon does not report one (builds predating
  #269) or nothing is serving.
- `cliVersion` — the version of the AgentInbox install making this call.
- `version` — legacy alias of `daemonVersion`; it is never filled with the
  CLI's version.

When a client command or `daemon start` finds a healthy daemon reporting a
different version than the CLI, a warning is printed to stderr.

Autostart (`daemon start` and implicit client startup) spawns the daemon from
a structurally resolved entry of the CLI's own install, not from the caller's
invocation path. Set `AGENTINBOX_DAEMON_ENTRY` to pin an explicit daemon
install entry script; an unusable entry fails explicitly instead of silently
falling back to the caller's build.

## Agent

```bash
agentinbox agent register [--agent-id ID] [--force-rebind] [--notify-lease-ms N] [--min-unacked-items N]
agentinbox agent register --agent-id ID --webhook-url URL [--webhook-activation-mode MODE] [--webhook-notify-lease-ms N] [--webhook-min-unacked-items N]
agentinbox agent list
agentinbox agent current
agentinbox agent show <agent_id>
agentinbox agent remove <agent_id>
agentinbox agent target list <agent_id>
agentinbox agent target add webhook <agent_id> --url <url>
agentinbox agent target remove <agent_id> <target_id>
```

`agent register` creates or refreshes the current runtime activation target.
Terminal-backed runtimes attach a terminal target. In Holon, the CLI can infer
`agentId` from `HOLON_AGENT_ID` and the webhook URL from
`HOLON_EXTERNAL_TRIGGER_URL`; otherwise pass `--webhook-url`.

## Agent delivery pause

```bash
agentinbox agent pause <agent_id>
agentinbox agent resume <agent_id> --delivery
```

Agent delivery pause is persistent and independent of inbox aggregation and
target offline state. Collection, inbox reads and explicit outbound replies
continue, but proactive webhook/terminal notifications (including digest,
retry and timer notifications) stop. Already-started requests may finish.
Resume catches up from unacknowledged backlog once per effective active target
without adding inbox entries; offline targets and retry backoff are preserved.
Repeated pause/resume calls do not replay successfully notified backlog, but
resume retries pending durable catch-up after its retry/defer backoff expires.
Use `--delivery` for delivery-only resume: repeated or concurrent calls preserve
offline targets. Without this flag, agent resume retains its existing recovery
of all offline targets and also clears the delivery pause, regardless of pause
history. `agentinbox agent target resume <agent_id> <target_id>` only recovers
that target and never unpauses agent delivery.

## Hosts

```bash
agentinbox host add <host_type> <host_key> [--config-json ...]
agentinbox host list
agentinbox host show <host_id>
agentinbox host schema <host_id>
```

## Sources

```bash
agentinbox source add <host_id> <stream_kind> <stream_key> [--config-json ...]
agentinbox source list
agentinbox source show <source_id>
agentinbox source update <source_id> [--config-json ...] [--config-ref ...]
agentinbox source remove <source_id>
agentinbox source pause <remote_source_id>
agentinbox source resume <remote_source_id>
agentinbox source schema <source_id>
agentinbox source poll <source_id>
agentinbox source event <source_id> --native-id <id> --event <variant>
```

`source pause` and `source resume` apply only to managed remote sources. Pause
stops the managed runtime without deleting its binding or stream checkpoint.
Resume goes back through the normal ensure path. Manual `source poll` does not
resume a paused source.

`source update` replaces persisted `config` and/or `configRef` in place while
preserving the existing `sourceId` and attached subscriptions.

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

The control-plane `POST /subscriptions` API now always returns a
`{ "subscriptions": [...] }` envelope. The CLI keeps the historical single
subscription JSON shape for non-shortcut calls, but shortcut-driven creates may
print the full envelope because one shortcut can expand into multiple
subscriptions.

`--shortcut` asks the source implementation to expand a named subscription
shortcut into the standard persisted fields. Use `agentinbox source schema
<source_id>` first to discover whether the source exposes any shortcuts and what
arguments they require. When `--shortcut` is present, do not also pass
`--filter-*`, `--tracked-resource-ref`, or `--cleanup-policy-json`; the
shortcut owns those fields.

`--tracked-resource-ref` persists an opaque resource identity such as `pr:373`
or `repo:holon-run/agentinbox:pr:373`, depending on the source implementation.
`--cleanup-policy-json` accepts the structured cleanup policy object persisted
with the subscription, for example `{"mode":"manual"}` or
`{"mode":"on_terminal_or_at","at":"2026-05-01T00:00:00.000Z","gracePeriodSecs":300}`.

## Inbox

Inbox commands use `agentId`, not `inboxId`.

```bash
agentinbox inbox list
agentinbox inbox show <agent_id>
agentinbox inbox read [--agent-id <agent_id>]
agentinbox inbox read <entry_id> [--agent-id <agent_id>] [--max-bytes <bytes>] [--no-fetch] [--cursor <token>] [--full]
agentinbox inbox attachment inspect <attachment_ref> [--agent-id <agent_id>]
agentinbox inbox attachment get <attachment_ref> [--agent-id <agent_id>] --output <path>
agentinbox inbox attachment delete <attachment_ref> [--agent-id <agent_id>]
agentinbox inbox send --agent-id <agent_id> --message "..." [--sender <sender>]
agentinbox inbox watch [--agent-id <agent_id>]
agentinbox inbox ack [--agent-id <agent_id>] --through <entry_id>
agentinbox inbox ack [--agent-id <agent_id>] --item <entry_id>
agentinbox inbox ack [--agent-id <agent_id>] --all
agentinbox inbox compact <agent_id>
```

Without an entry ID, `inbox read` retains its existing list behavior. With an
email entry ID, it returns a bounded normalized text page. Reading is local
first; omit `--no-fetch` to allow UXC to retrieve missing content. If
`body.hasMore` is true, pass the returned `body.nextCursor` with the same entry
ID to continue the fixed snapshot. `--full` is accepted for compatibility in
single-entry mode but never exposes the internal UXC `message_ref`.

The result reports `complete`, `partial`, or `unverified` body completeness
separately from output pagination. It includes only safe attachment display
metadata. `attachment inspect` reads that metadata without downloading.
For sources configured with `attachmentPolicy.mode=store_reference`,
`attachment get` performs bounded on-demand materialization and writes the
binary response on the client side. The output path is created exclusively and
is never sent to the daemon. `attachment delete` is ownership-checked and
idempotently tombstones the reference; managed bytes are removed only after no
live attachment references share the content-addressed object. Deleted,
quarantined, and rejected attachments cannot be read.

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
