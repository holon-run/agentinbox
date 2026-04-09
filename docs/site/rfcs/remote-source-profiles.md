---
title: Remote Source Profiles
date: 2026-04-09
type: page
summary: Define how AgentInbox should converge external sources onto one remote-source runtime with builtin and user-defined source profiles on top of UXC managed source streams.
---

# Remote Source Profiles

## Summary

`AgentInbox` should converge all external sources onto one shared
`remote_source` runtime.

On top of that runtime, `AgentInbox` should support two kinds of source
profiles:

- builtin profiles maintained by `AgentInbox`
- user-defined profiles provided by users or repos

This keeps `local_event` as the one local ingress runtime, while making all
external-provider sources share one common hosting model built on top of `uxc`
managed source streams.

## Problem

Today these source types are product-level siblings:

- `github_repo`
- `github_repo_ci`
- `feishu_bot`
- reserved `remote_source`

But the actual runtime story is inconsistent:

- each builtin source owns its own polling/subscription/runtime logic
- `uxc` is already doing the hard provider-facing work
- `remote_source` exists in the public model but is still reserved

This has three costs:

1. every new builtin source tends to add another hard-coded runtime
2. users still do not have a supported custom remote-source path
3. the product model is harder to explain than it needs to be

## Goals

- unify all external-provider source hosting behind one runtime model
- keep `local_event` separate and simple
- preserve easy builtin source types for the common path
- enable user-defined remote sources without patching core runtime logic
- make `uxc` the provider-ingress layer and `AgentInbox` the product layer

## Non-Goals

- do not remove `local_event`
- do not make `uxc` responsible for product-layer filtering or inbox routing
- do not require every source profile to be purely declarative on day one
- do not expose `uxc` implementation details as the primary user-facing model

## Design

## Runtime Model

`AgentInbox` should have two runtime classes:

- `local_event`
- `remote_source`

### `local_event`

`local_event` remains the local programmable ingress source:

- append events directly into `AgentInbox`
- no `uxc` managed source or stream required

### `remote_source`

`remote_source` becomes the single runtime for all external sources:

- GitHub
- GitHub CI
- Feishu
- future builtin sources
- future user-defined remote sources

The key idea is:

- `uxc` owns provider-facing ingress runtime and durable raw streams
- `AgentInbox` owns product mapping and agent-facing semantics

## Profile Model

Each `remote_source` is backed by a source profile.

There are two profile classes:

- builtin profiles
- user-defined profiles

### Builtin Profiles

Builtin profiles keep the easy product-facing source types:

- `github_repo`
- `github_repo_ci`
- `feishu_bot`

These remain the friendly public entry points, but internally they are just
official profiles executed by the shared `remote_source` runtime.

### User-Defined Profiles

User-defined profiles let repos and users add custom remote sources without
adding a new core runtime.

These are still hosted by the same `remote_source` runtime and should follow
the same lifecycle and event-mapping contract as builtin profiles.

## Boundary With UXC

The recommended split is:

### `uxc` owns

- external provider auth and transport
- polling / long-connection / protocol execution
- provider-side checkpoint
- managed source identity
- durable append-only raw stream

### `AgentInbox` owns

- source registry
- source schemas shown to users and agents
- profile resolution
- raw event -> `eventVariant` / `metadata` / `rawPayload` mapping
- subscription filters
- inbox materialization
- activation / delivery

## Important Ownership Rule

`uxc` should expose a raw-oriented stream boundary.

`AgentInbox` should own the final product event model:

- `sourceNativeId`
- `eventVariant`
- `metadata`
- `rawPayload`
- optional summary helpers

This avoids double-normalization and keeps `uxc` product-neutral.

## Profile Contract

The first implementation does not need to be fully declarative.

The important thing is to standardize one profile contract that both builtin
and user-defined remote sources can target.

Suggested shape:

```ts
interface RemoteSourceProfile {
  id: string
  validateConfig(config: Record<string, unknown>): void
  buildManagedSourceSpec(source: SubscriptionSource): ManagedSourceSpec
  mapRawEvent(
    rawPayload: Record<string, unknown>,
    source: SubscriptionSource,
  ): {
    sourceNativeId: string
    eventVariant: string
    metadata: Record<string, unknown>
    rawPayload: Record<string, unknown>
    occurredAt?: string
  } | null
}
```

### `buildManagedSourceSpec`

Builds the `uxc` managed source spec:

- endpoint
- operation id
- args
- mode
- poll config
- transport hint
- runtime options

### `mapRawEvent`

Maps one `uxc` `raw_payload` into an `AgentInbox` event.

This is where product-level semantics live:

- `eventVariant`
- normalized `metadata`
- stable `sourceNativeId`
- event timestamp selection

## Data Model

`AgentInbox` source state should stop storing `uxcJobId`.

Instead, for `remote_source`, source checkpoint should only track:

- managed source identity
- stable `streamId`
- the consumer cursor used by `AgentInbox` when reading that stream

Suggested checkpoint shape:

```json
{
  "managedSource": {
    "namespace": "agentinbox",
    "sourceKey": "github_repo:holon-run/agentinbox",
    "streamId": "stream_agentinbox_github_repo_holon-run_agentinbox"
  },
  "streamCursor": {
    "afterOffset": 1234
  }
}
```

This keeps the layers clean:

- `uxc` stores provider checkpoint
- `AgentInbox` stores consumer read progress

## Builtin Type Mapping

Public source types should remain easy to use:

- `local_event`
- `github_repo`
- `github_repo_ci`
- `feishu_bot`
- `remote_source`

But the internal runtime mapping changes to:

- `local_event` -> local runtime
- `github_repo` -> remote runtime + builtin profile
- `github_repo_ci` -> remote runtime + builtin profile
- `feishu_bot` -> remote runtime + builtin profile
- `remote_source` -> remote runtime + user-specified profile

This preserves the current easy product surface while unifying the
implementation.

## Runtime Flow

For a `remote_source`, the sync flow should be:

1. resolve the profile
2. validate source config
3. build the `uxc` managed source spec
4. call `uxc source.ensure(namespace, source_key, spec)`
5. persist returned `streamId`
6. call `uxc stream.read(streamId, afterOffset)`
7. map each `raw_payload` through the profile
8. append mapped events into the `AgentInbox` source event bus
9. update `afterOffset`

This replaces the old direct `uxc subscribeStart` / `subscription.events`
coupling.

## Lifecycle

The lifecycle should align with the new `uxc` managed source API.

### Register / Ensure

For an active remote source:

- `AgentInbox` calls `uxc source.ensure(...)`
- `uxc` reuses or replaces the managed source runtime
- `AgentInbox` continues consuming the stable stream

### Pause

Pausing a remote source should call:

- `uxc source.stop(namespace, source_key)`

This stops ingress but keeps the managed source binding and stream intact.

### Remove

Removing a remote source should call:

- `uxc source.delete(namespace, source_key)`

This lets `AgentInbox` cleanly delete the managed ingress binding instead of
leaving orphaned remote runtime state behind.

## Declarative Profiles

The long-term direction should support profiles that are mostly declarative.

Typical declarative responsibilities:

- managed source spec construction
- provider operation selection
- mode selection
- raw event extraction path
- metadata mapping
- payload mapping
- event-variant mapping

However, the initial design should not require every profile to be purely
declarative.

Some builtin profiles may still need lightweight mapping helpers while the
contract settles.

## Why This Design

This design gives `AgentInbox` a cleaner architecture:

- only one external-source runtime to reason about
- builtin and custom remote sources use the same lifecycle
- `uxc` does the stateful provider work once
- product semantics stay in `AgentInbox`

It also creates a clean path for the current reserved `remote_source` type to
become real without adding yet another special-case runtime.

## Open Questions

- Should user-defined profiles be file-based, repo-based, or registry-based in
  v1?
- How much of builtin profile logic should be declarative in the initial
  implementation versus lightweight code helpers?
- Should builtin public source types remain permanently visible, or eventually
  become aliases over `remote_source + profile` in the CLI and HTTP API?

## Recommended Direction

The recommended direction is:

- keep `local_event` separate
- converge all external sources onto `remote_source`
- keep builtin source types as friendly public aliases
- implement builtin and user-defined remote sources through one profile
  contract
- make `uxc` the ingress/stream layer and `AgentInbox` the product mapping
  layer

This is the architecture that issue `#37` should target.
