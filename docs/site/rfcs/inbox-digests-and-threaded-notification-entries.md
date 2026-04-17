---
title: Inbox Digests And Threaded Notification Entries
date: 2026-04-17
type: page
summary: Reduce bursty notification noise by keeping raw inbox items immutable, while materializing agent-facing digest threads and immutable digest snapshots for read, activation, and ack.
---

# Inbox Digests And Threaded Notification Entries

## Summary

`AgentInbox` should reduce bursty notification noise without hiding or
destroying the original source events.

The current activation buffer can coalesce bursts into fewer dispatches, but it
still leaves the runtime with the same core problem:

- the runtime receives fewer wakeups
- but it still needs to read many raw `InboxItem` records to understand one
  logical burst

This RFC proposes a two-layer model:

- keep raw `InboxItem` records immutable and durable
- add an agent-facing read model made of:
  - stable `InboxEntry` records
  - logical `DigestThread` grouping
  - immutable `DigestSnapshot` entries for read, activation, and ack

In this model:

- source events still enter the system one by one
- aggregation happens after durable ingest, but before activation/read
- runtimes can read compact digest entries instead of reconstructing grouping
  themselves
- ack stays stable by targeting immutable snapshots rather than mutable live
  threads

## Problem

For bursty sources such as GitHub PR reviews or CI updates, one logical unit of
work often arrives as many raw events:

- several review comments on the same PR
- multiple CI status changes on the same branch or PR
- related timeline or resource updates emitted over a short period

Today `AgentInbox` already batches activation dispatches using a service-level
window and max-items threshold, but that only reduces activation frequency. It
does not change the agent-facing read surface.

That means the runtime still has to:

1. receive an activation
2. read raw inbox items
3. discover that many items are about the same object
4. re-aggregate them in runtime logic

This pushes grouping semantics back into the runtime, which conflicts with the
product boundary.

## Goals

- reduce notification noise for bursty, related source events
- keep raw inbox items durable and replayable
- let runtimes read one compact digest instead of reconstructing grouping from
  many raw items
- keep ack semantics stable even when a logical digest thread continues to
  receive new items over time
- keep source-specific grouping knowledge at the source/module edge, not in
  generic core heuristics
- preserve the current shared-source, agent-specific-subscription model

## Non-Goals

- do not delete or replace raw `InboxItem` records with aggregate-only data
- do not make grouping a source-ingest concern
- do not move grouping logic into downstream runtimes
- do not make outbound delivery responsible for aggregation
- do not force all sources to support grouping on day one

## Design Principles

## 1. Raw Facts Stay Raw

`InboxItem` remains the immutable, durable record of what the source produced.

Aggregation should not mutate or collapse the fact layer. It should build an
agent-facing read model on top of it.

## 2. Read Units Must Be Stable

If a runtime reads a digest and later acks it, the meaning of that ack must not
change underneath it.

That means:

- live grouping can evolve over time
- but read/ack must operate on immutable snapshots

## 3. Grouping Belongs At The Inbox Presentation Boundary

Grouping should happen:

- after item ingest
- before activation/read
- inside `AgentInbox`

It should not live:

- in the source adapter’s durable ingest path
- in outbound delivery
- in the runtime

## 4. Source Semantics At The Edge

The core should not try to infer too much provider-specific meaning.

Source or module implementations should be able to supply:

- groupability hints
- resource references
- event family classification
- summary hints
- immediate-flush hints

The core can provide a conservative fallback, but high-quality grouping should
come from the source edge.

## Current State

Today the relevant pieces are:

- raw `InboxItem` storage
- subscription matching
- target notification buffering
- activation dispatch
- ack by item id / through item id

The existing activation buffer:

- groups only by target
- has no concept of resource/thread grouping
- does not create a stable grouped read model
- uses summary coalescing only for dispatch, not for inbox read

So it solves “fewer wakeups” but not “fewer things to read”.

## Core Design

## 1. Add An Agent-Facing `InboxEntry` Read Model

`InboxItem` remains the fact layer.

On top of it, `AgentInbox` should introduce a new agent-facing read model:

- `InboxEntry`

An `InboxEntry` is what runtimes read, what activations reference, and what ack
targets by default.

Suggested entry kinds:

- `item`
  - a direct pass-through view over one raw `InboxItem`
- `digest_snapshot`
  - a compact grouped entry representing many raw inbox items

This means the runtime-facing mailbox becomes a presentation model, not just a
raw event table.

## 2. Introduce `DigestThread` As The Logical Group

Some related events should continue to accumulate into one logical thread as
long as that thread remains active and unacked.

Suggested internal object:

- `DigestThread`

Responsibilities:

- own the grouping identity for one logical burst/conversation/object
- accumulate related raw inbox item ids over time
- track first/last item timestamps
- decide whether later items still belong to the same logical thread

`DigestThread` is mutable and long-lived.

It is **not** the object that runtimes ack directly.

## 3. Materialize Immutable `DigestSnapshot` Entries

Because a live thread can change over time, runtimes should never ack the live
thread directly.

Instead, each visible grouped entry should be an immutable snapshot of a thread
at a particular revision.

Suggested object:

- `DigestSnapshot`

Suggested fields:

- `entryId`
- `threadId`
- `revision`
- `groupKey`
- `itemIds`
- `count`
- `summary`
- `firstItemAt`
- `lastItemAt`
- `sourceIds`
- `subscriptionIds`
- `deliveryHandle?`
- `sequence`
- `ackedAt?`
- `supersededAt?`

Behavior:

- the logical thread can continue to evolve
- but each snapshot is immutable once created
- read returns snapshots
- ack targets snapshots

This is what keeps read/ack semantics stable.

## 4. Grouping Is Keyed By Resource + Event Family

Grouping should be driven by a source/module-provided grouping hint.

Suggested minimum group key components:

- `agentId`
- `sourceId`
- `resourceRef`
- `eventFamily`

Examples:

- `github_repo + pr:135 + review_comments`
- `github_repo_ci + pr:135 + ci_updates`

Default fallback should be conservative, for example:

- `sourceId + eventVariant`

If a source cannot provide useful grouping semantics, `AgentInbox` should
prefer under-grouping over incorrect grouping.

## 5. Aggregation Policy Belongs To The Agent-Facing Inbox Layer

Because grouped entries are part of the shared read model for an agent inbox,
aggregation policy should not be target-specific.

That is an important boundary:

- target notification policy decides **when** to remind
- inbox aggregation policy decides **what** the runtime reads

Suggested placement:

- agent-level default policy
- optional subscription-level override later

Phase 1 suggested policy shape:

```ts
type InboxAggregationPolicy = {
  enabled?: boolean;
  windowMs?: number;
  maxItems?: number;
  maxThreadAgeMs?: number;
};
```

This is separate from:

- `notifyLeaseMs`
- `minUnackedItems`
- terminal gating heuristics

## 6. Two-Stage Aggregation: Burst Buffer + Unacked Thread Merge

Pure time-window grouping is not enough.

If grouping only happens within a short flush window, it solves simultaneous
bursts but not long-lived notification threads like social-network notifications.

So the model should have two stages:

### Stage A: Burst Buffer

New raw items enter a short pending aggregation buffer keyed by the grouping
key.

This prevents re-materializing the thread on every single event in a burst.

### Stage B: Unacked Thread Merge

When the burst buffer flushes:

- if there is no open digest thread, create one
- if there is an existing unacked thread with the same group key, merge into
  that thread
- materialize a new immutable snapshot for the thread’s new revision

This is what allows cross-time grouping while still keeping stable snapshots.

## 7. Flush Rules

The pending burst buffer should flush when any of these happen:

- `windowMs` expires
- `maxItems` is reached
- source/module marks an event as `immediate`
- host/subscription/agent lifecycle requires cleanup

The logical thread itself should roll over and start a new thread when:

- the previous thread is acked
- the event family changes in a way that should not merge
- a source/module marks the event as thread-breaking
- the thread exceeds `maxThreadAgeMs`

## 8. Source/Module Hooks

`RemoteSourceModule` should be able to provide optional grouping hooks.

Suggested hook shape:

```ts
deriveNotificationGrouping?(item, source, subscription) => {
  groupable: boolean;
  resourceRef?: string | null;
  eventFamily?: string | null;
  summaryHint?: string | null;
  flushClass?: "normal" | "immediate";
}
```

Later, modules may also provide:

```ts
summarizeDigestThread?(items, context) => string | null
```

This keeps source semantics at the edge:

- GitHub can define PR/resource-aware grouping
- GitHub CI can define CI burst grouping
- user-defined remote sources can opt in

## 9. Identifier Strategy

The new aggregation-layer objects should optimize for local operator and
runtime interaction, not for globally opaque UUID-style identifiers.

For this RFC, the recommended strategy is:

- store `DigestThread` with an integer primary key
- store `InboxEntry` / `DigestSnapshot` with an integer primary key
- expose agent-facing refs with typed prefixes

Suggested agent-facing refs:

- `thr_<thread_id>`
- `ent_<entry_id>`

Examples:

- `thr_12`
- `ent_42`

This keeps the storage model simple and the agent-facing surface compact:

- lower token cost in LLM-heavy loops
- easier CLI usage such as `ack --through ent_42`
- clear type distinction between threads and entries

The database should still keep ordering concerns separate from identity.

Recommended shape:

- `thread_id INTEGER PRIMARY KEY`
- `entry_id INTEGER PRIMARY KEY`
- `sequence INTEGER NOT NULL UNIQUE`

Where:

- `thread_id` identifies one logical digest thread
- `entry_id` identifies one immutable read/ack unit
- `sequence` defines inbox ordering and `ack --through` boundaries

If phase 1 wants to keep things even simpler, it is acceptable for
`entry_id == sequence`, but the conceptual model should still treat:

- identity as `entry_id`
- visible ordering as `sequence`

Formatting and parsing the typed refs should happen at the boundary layer. The
database itself does not need to store literal strings like `ent_42`.

## Read And Ack Semantics

## 1. Read Returns Stable Entries

Default inbox read should return `InboxEntry[]`, not just raw inbox items.

For grouped bursts, the runtime sees one `digest_snapshot` entry instead of
many related raw items.

If the runtime wants details, it can explicitly expand a digest snapshot into
its referenced raw `itemIds`.

## 2. Ack Targets Immutable Snapshots

Ack should continue to support batch semantics, but the ack object should be a
stable entry boundary.

Recommended behavior:

- `ack entryId`
- `ack --through <entryId>`

For digest snapshots:

- acking the snapshot acks the raw `InboxItem` set referenced by that snapshot
- if the logical thread has advanced to a newer revision, later items are not
  acked implicitly

This preserves stable boundaries even when the underlying digest thread keeps
growing.

## 3. Superseded Snapshots Stay Valid Ack Boundaries

If a digest thread receives more items and materializes a newer snapshot:

- the older snapshot may be hidden from the default visible read set
- but it remains a valid ack boundary for any runtime that already read it

This avoids the “read/ack window changed underneath me” problem.

## Activation Semantics

Activation should target `InboxEntry` units, not raw inbox item batches.

That means:

- a burst may generate one digest snapshot activation
- the runtime reads one digest entry
- the runtime can expand raw child items only when needed

This keeps activation, read, and ack aligned on the same agent-facing object.

## Compatibility

Phase 1 does not need to remove the raw-item APIs immediately.

A safe rollout path is:

1. keep raw `InboxItem` storage and internal behavior unchanged
2. add `InboxEntry` and digest thread materialization alongside it
3. make runtime-facing inbox read default to entries
4. keep an explicit raw-item read path for debugging, replay, and low-level
   tooling

This preserves operability while shifting the default experience to grouped
reads.

## Observability

Aggregation must be observable.

Suggested metrics/events:

- thread created
- snapshot materialized
- flush reason (`window`, `size`, `immediate`, `rollover`)
- group size distribution
- merge-into-existing-thread count
- expand-digest-to-raw-item usage

Without these, grouping bugs will be difficult to debug.

## Why Not Only Activation-Level Aggregation

An earlier, simpler option would have been:

- keep inbox read raw
- only collapse activation dispatch summaries

This is insufficient because it only reduces wakeups, not runtime work.

The runtime would still need to:

- read all raw items
- regroup them itself

That would move grouping semantics back into runtime logic, which is not the
intended boundary.

## Why Not Replace Raw Items Entirely

Replacing raw items with only aggregate records would make:

- replay harder
- debugging harder
- source correctness harder to verify
- regrouping impossible without information loss

So raw `InboxItem` records must remain the durable fact layer.

## Phased Rollout

### Phase 1

- land this RFC
- add simulation tests for:
  - burst buffering
  - thread merge
  - immutable snapshots
  - ack-through snapshot boundaries

### Phase 2

- implement core digest-thread primitives
- implement one generic grouping strategy
- add entry-based inbox read and snapshot-based ack

### Phase 3

- add source/module grouping hooks
- dogfood with `github_repo` and `github_repo_ci`

## Open Questions

- should digest expansion be part of inbox read, or a separate explicit
  endpoint?
- should aggregation policy live at agent inbox level only, or later allow
  subscription-level override?
- should non-groupable critical events bypass digest threads entirely, or still
  attach to the thread with `flushClass = immediate`?

## Conclusion

`AgentInbox` should not stop at reducing activation frequency.

To actually lower runtime overhead, it needs an agent-facing grouped read model
that:

- preserves raw inbox items as facts
- materializes digest threads and immutable snapshots
- aligns activation, read, and ack on the same stable grouped object

That gives `AgentInbox` a real inbox-level notification aggregation model,
instead of leaving runtimes to rediscover grouping from raw events.
