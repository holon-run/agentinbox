# AgentInbox Event Bus Backend Design

This document defines the next-step event bus architecture for `AgentInbox`.

The goal is not to turn `AgentInbox` into a general-purpose broker.
The goal is to separate three concerns that are currently too tightly coupled:

- source ingress
- event retention and consumer offsets
- inbox delivery for local agents

## Why This Refactor Exists

The current implementation keeps one source-level checkpoint for each hosted
source.

That is enough to prove shared source hosting, but it is not enough to model
independent consumers on top of the same source.

Today:

- one source has one consumption position
- multiple subscriptions on the same source share that position
- later subscriptions can miss earlier source events

The new design changes that:

- source ingress position remains source-level
- subscription consumption position becomes subscription-level
- one source can safely feed multiple independent subscriptions

This is closer to Kafka, JetStream, and other mature event log systems.

## Goals

- keep `AgentInbox` as the shared ingress and delivery layer
- define a backend abstraction that can support:
  - embedded SQLite today
  - JetStream later
  - Kafka later
  - a future Rust implementation later
- keep product vocabulary close to `AgentInbox`
- keep backend semantics close to mature stream systems
- support one source feeding multiple subscriptions with independent cursors
- support replay and backfill without re-polling the external source

## Non-Goals

- do not expose Kafka partitions or broker administration directly in the main
  `AgentInbox` API
- do not replace `Inbox` with generic queue terminology everywhere
- do not make the backend abstraction responsible for source-specific delivery
- do not push runtime task semantics into the backend

## Vocabulary

Use two layers of terms on purpose.

### Product Vocabulary

- `Source`
  - external ingress source, such as a GitHub repo
- `Subscription`
  - agent-specific filtered consumer on top of a source
- `Inbox`
  - agent-facing inbox destination
- `InboxItem`
  - item delivered to an inbox after subscription matching
- `DeliveryHandle`
  - outbound reply/update target

### Backend Vocabulary

- `Stream`
  - append-only event log for one source
- `StreamEvent`
  - one normalized source event written once into the stream
- `Consumer`
  - backend consumer identity for one subscription
- `Offset`
  - consumer progress in the stream

### Mapping

- one `Source` maps to one backend `Stream`
- one `Subscription` maps to one backend `Consumer`
- one `StreamEvent` can produce zero, one, or many `InboxItem`s
- `InboxItem` ack is not the same thing as backend offset commit

## Target Architecture

The refactor should separate the runtime into three pipelines.

### 1. Source Ingress

Responsibilities:

- host the external subscription or poll loop
- normalize source-native payloads into `StreamEvent`
- append them to the backend
- advance only the source ingress checkpoint

Source ingress does not fan out directly to inboxes.

### 2. Subscription Consumption

Responsibilities:

- read `StreamEvent`s from the backend using a subscription-specific consumer
- evaluate subscription match rules
- materialize matching `InboxItem`s
- create `Activation`s
- commit that subscription's offset

Each subscription consumes independently.

### 3. Inbox Delivery

Responsibilities:

- expose inbox read and ack APIs to runtimes
- keep `InboxItem` state independent from stream offsets
- preserve `DeliveryHandle` for outbound replies

## Current To Target Data Model

Current model:

- `Source`
- `Interest`
- `InboxItem`

Target model:

- `Source`
- `Subscription`
- `StreamEvent`
- `Inbox`
- `InboxItem`

Notes:

- `Interest` should become `Subscription`
- `InboxItem` should stop doubling as the source journal
- `StreamEvent` becomes the single durable source-side event record

## Backend Interface

The backend interface should be small and opinionated.

It should describe event-log behavior, not provider-specific behavior.

```ts
export interface EventBusBackend {
  ensureStream(input: EnsureStreamInput): Promise<StreamRecord>;
  append(input: AppendEventsInput): Promise<AppendEventsResult>;

  ensureConsumer(input: EnsureConsumerInput): Promise<ConsumerRecord>;
  getConsumer(input: GetConsumerInput): Promise<ConsumerRecord | null>;
  read(input: ReadEventsInput): Promise<ReadEventsResult>;
  commit(input: CommitOffsetInput): Promise<CommitOffsetResult>;
  reset(input: ResetConsumerInput): Promise<ConsumerRecord>;

  getStreamStats(streamId: string): Promise<StreamStats>;
  getConsumerLag(input: GetConsumerLagInput): Promise<ConsumerLag>;
}
```

Suggested supporting types:

```ts
export interface StreamRecord {
  streamId: string;
  sourceId: string;
  streamKey: string;
  backend: string;
  createdAt: string;
}

export interface StreamEventRecord {
  offset: number;
  streamEventId: string;
  streamId: string;
  sourceId: string;
  sourceNativeId: string;
  eventVariant: string;
  occurredAt: string;
  metadata: Record<string, unknown>;
  rawPayload: Record<string, unknown>;
  providerRawPayload?: Record<string, unknown>;
  deliveryHandle: Record<string, unknown> | null;
}

export interface ConsumerRecord {
  consumerId: string;
  streamId: string;
  subscriptionId: string;
  consumerKey: string;
  nextOffset: number;
  startPolicy: "latest" | "earliest" | "at_offset" | "at_time";
  createdAt: string;
  updatedAt: string;
}

export interface ReadEventsResult {
  consumer: ConsumerRecord;
  events: StreamEventRecord[];
  highWatermarkOffset: number;
}
```

### Backend Rules

- `append()` must be idempotent on source identity
- `read()` must not change offsets
- `commit()` must advance one consumer only
- offsets belong to consumers, not streams
- stream offsets are monotonic and append-only

## SQLite Backend

The first implementation should be embedded and local.

SQLite is enough because the current problem is durable local event retention,
not high-throughput distributed messaging.

### Tables

#### `streams`

One record per hosted source stream.

```sql
create table if not exists streams (
  stream_id text primary key,
  source_id text not null unique,
  stream_key text not null unique,
  backend text not null,
  created_at text not null
);
```

#### `stream_events`

Append-only normalized source journal.

```sql
create table if not exists stream_events (
  offset integer primary key autoincrement,
  stream_event_id text not null unique,
  stream_id text not null,
  source_id text not null,
  source_native_id text not null,
  event_variant text not null,
  occurred_at text not null,
  metadata_json text not null,
  raw_payload_json text not null,
  delivery_handle_json text,
  created_at text not null,
  unique(stream_id, source_native_id, event_variant)
);

create index if not exists idx_stream_events_stream_offset
  on stream_events(stream_id, offset);

create index if not exists idx_stream_events_stream_occurred_at
  on stream_events(stream_id, occurred_at);
```

Notes:

- `offset` is the backend ordering key
- `unique(stream_id, source_native_id, event_variant)` keeps source ingress
  idempotent
- `created_at` is insertion time
- `occurred_at` is source event time

#### `consumers`

One record per subscription consumer.

```sql
create table if not exists consumers (
  consumer_id text primary key,
  stream_id text not null,
  subscription_id text not null unique,
  consumer_key text not null unique,
  start_policy text not null,
  start_offset integer,
  start_time text,
  next_offset integer not null,
  created_at text not null,
  updated_at text not null
);

create index if not exists idx_consumers_stream
  on consumers(stream_id);
```

Notes:

- `next_offset` is the next unread offset for this consumer
- offset state lives here, not on `sources`

#### `consumer_commits`

Optional audit table for debugging and observability.

```sql
create table if not exists consumer_commits (
  commit_id text primary key,
  consumer_id text not null,
  stream_id text not null,
  committed_offset integer not null,
  committed_at text not null
);

create index if not exists idx_consumer_commits_consumer
  on consumer_commits(consumer_id, committed_offset);
```

This table is not required for correctness.
It is useful for debugging, replay audits, and operator visibility.

### Existing Tables That Stay

The following current tables still make sense:

- `sources`
- `interests`, to be renamed to `subscriptions`
- `inbox_items`
- `activations`
- `deliveries`

The key change is:

- `inbox_items` stops being the only durable event store
- `stream_events` becomes the source journal

## Subscription Start Policy

New subscriptions need an explicit start policy.

Recommended options:

- `latest`
  - begin after the current high watermark
- `earliest`
  - consume from offset `1`
- `at_offset`
  - consume from an explicit offset
- `at_time`
  - consume from the first event at or after a timestamp

Recommended default:

- runtime-created subscriptions default to `latest`
- operator/debug subscriptions may choose `earliest`

This avoids accidental inbox floods while keeping replay explicit.

## Event Consumption Logic

### Source Ingress Logic

1. source adapter receives or polls source-native events
2. source adapter normalizes them into `StreamEvent` payloads
3. source adapter calls `backend.append()`
4. source adapter updates source ingress checkpoint

Important:

- source ingress checkpoint tracks external source progress
- it does not track any subscription's read progress

For GitHub, source ingress checkpoint still includes things such as:

- `uxcJobId`
- `afterSeq`
- `lastEventAt`
- `lastError`

But this checkpoint now means:

- how far the GitHub adapter has read from GitHub/UXC

It no longer means:

- how far subscriptions have consumed the stream

### Subscription Consumption Logic

1. ensure backend consumer exists for the subscription
2. call `backend.read(streamId, consumerId, limit)`
3. for each returned `StreamEvent`:
   - evaluate subscription match rules
   - if matched, write one `InboxItem`
   - if matched, create one `Activation`
4. after the batch is processed, call `backend.commit()` with the last consumed
   offset

Important:

- commit happens after processing the batch
- commit does not depend on inbox ack
- inbox ack is runtime-side handling state, not stream consumption state

### Multiple Subscriptions On One Source

This is the main reason to add the backend.

Behavior:

- one source writes one stream
- subscription A has consumer A and its own offset
- subscription B has consumer B and its own offset
- both can read the same `StreamEvent`
- both can materialize different `InboxItem`s
- A can advance without affecting B

This is the Kafka-like property the current design is missing.

### No Subscription Case

When a source exists but there are no subscriptions:

- source ingress should still be allowed to append to the stream
- no consumer offset is advanced because no consumer exists
- backlog remains available for future subscriptions using `earliest` or
  `at_time`

This is better than the current temporary rule that skips source progress when
there are zero subscriptions.

With the backend refactor, that workaround should be removed.

### Inbox Ack Logic

Inbox ack remains separate:

- subscription commit says: this subscription has processed the stream batch
- inbox ack says: the runtime has handled this inbox item

This separation is deliberate.

It avoids coupling stream progress to runtime behavior.

## Delivery Semantics

`DeliveryHandle` should continue to be captured on the `StreamEvent` and copied
into `InboxItem`.

Reasons:

- replayed inbox items still need the same outbound target context
- runtime should not reconstruct provider-specific reply targets

## Backend Swappability

The abstraction should preserve these invariants across backends:

- one source maps to one stream
- one subscription maps to one consumer
- offsets belong to consumers
- stream events are append-only
- commit is explicit

How this maps later:

- SQLite backend
  - `stream_events.offset` is the source of truth
- JetStream backend
  - stream sequence maps to offset
- Kafka backend
  - topic + partition offset maps to offset

`AgentInbox` should keep the same higher-level API even if the backend changes.

## Migration Plan

### Phase 1

- add backend interface
- add SQLite backend implementation
- keep current source adapters

### Phase 2

- add `stream_events` and `consumers`
- keep existing `inbox_items`
- change source adapters to append into backend first

### Phase 3

- rename `Interest` to `Subscription`
- add subscription start policy
- materialize inbox items from backend consumer reads

### Phase 4

- remove direct source-to-inbox assumptions from adapters
- make future JetStream/Kafka backend implementations possible

## Recommended First Refactor Slice

The smallest valuable refactor is:

1. add `stream_events`
2. add `consumers`
3. move source append into `stream_events`
4. introduce one subscription consumer loop for GitHub
5. keep existing inbox API unchanged

This gets the data model right without forcing a full external-broker decision.
