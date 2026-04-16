---
title: Source Hosts And Streams
date: 2026-04-16
type: page
summary: Split provider/account hosting from concrete feeds so AgentInbox can support many provider streams without exploding top-level source types.
---

# Source Hosts And Streams

## Summary

`AgentInbox` should stop treating every provider feed or endpoint as a separate
top-level source kind.

Instead, it should separate:

- source host
- stream
- subscription

This keeps the provider/account runtime small and shared, while allowing many
concrete feeds to exist under one host without exploding the top-level source
model.

This RFC proposes:

- treat the provider/account/auth context as the shared host
- treat concrete feeds such as repo events, CI runs, timelines, searches, or
  bookmarks as streams under that host
- keep subscriptions agent-specific on top of a stream
- preserve the existing shared-source product boundary
- map current source kinds such as `github_repo` and `github_repo_ci` to
  compatibility aliases over a host-plus-stream model

## Problem

Today the model trends toward making each provider feed a top-level source
kind.

That works for a small number of builtin cases, but it scales poorly.

Examples:

- GitHub repo events
- GitHub CI runs
- future GitHub notifications
- future GitHub discussions

And for `X`, the problem gets much worse:

- home timeline
- user timeline
- bookmarks
- search results
- mentions
- liked posts
- other list or filter driven feeds

If each of these becomes a separate top-level source kind, several problems
follow:

- type explosion in the public model
- duplicate provider hosting/runtime logic
- awkward capability discovery
- too many near-duplicate source definitions
- no clear place to share auth/runtime/provider state while keeping feed-level
  checkpoints separate

## Goals

- keep provider/account runtime hosting shared
- let many concrete feeds exist under one provider host
- preserve separate checkpoints and configs per feed
- avoid top-level source-kind explosion
- keep the shared source, agent-specific subscription model intact
- provide a compatibility path from current source kinds

## Non-Goals

- do not collapse all providers into one universal mega-host
- do not remove the existing shared source concept from the product boundary
- do not force an immediate breaking CLI rename
- do not move runtime semantics into AgentInbox

## Core Design

## 1. Separate Host From Stream

The top-level hosted object should represent the provider/account/runtime
context, not the concrete feed.

Suggested layers:

- `SourceHost`
- `SourceStream`
- `Subscription`

### `SourceHost`

The shared provider/account/auth/runtime context.

Examples:

- GitHub host with one auth context
- X host with one auth context
- Feishu host with one bot/auth context

Responsibilities:

- own provider auth reference
- own provider client/runtime binding
- expose which stream kinds are available
- host shared lifecycle and connection state

### `SourceStream`

A concrete feed or append-only stream under a host.

Examples:

- GitHub repo events for `holon-run/agentinbox`
- GitHub CI runs for `holon-run/agentinbox`
- X home timeline
- X user timeline for `@foo`
- X search for query `agentinbox`

Responsibilities:

- own stream-specific config
- own stream-specific checkpoint
- poll or receive that concrete feed
- normalize raw provider events into AgentInbox items

### `Subscription`

An agent-specific filter and delivery rule over a concrete stream.

This stays conceptually the same as today.

## 2. Shared Host, Separate Checkpoints

One reason this split matters is checkpoint ownership.

These are not the same feed and should not share checkpoint state:

- GitHub repo events
- GitHub CI runs
- X home timeline
- X search for `"foo"`
- X search for `"bar"`

They may share:

- provider auth
- runtime/client
- host lifecycle

But they must not share:

- stream config
- polling cursor
- checkpoint
- stream-specific normalization state

That makes `stream` the right unit for polling and checkpointing, not host.

## 3. Top-Level Source Kinds Should Collapse Toward Hosts

The public type surface should move toward a smaller set of provider-facing host
kinds.

Examples:

- `github`
- `x`
- `feishu`
- `local_event`

Then each host exposes stream kinds.

Example GitHub stream kinds:

- `repo_events`
- `ci_runs`
- future `notifications`
- future `discussions`

Example X stream kinds:

- `home_timeline`
- `user_timeline`
- `bookmarks`
- `search`
- `mentions`

This keeps the public model much smaller without losing feed-level specificity.

## 4. Streams Are The Real Reusable Hosting Unit For Polling

The shared-source principle still holds, but the concrete unit of reuse becomes
more precise:

- host is reusable provider runtime
- stream is reusable concrete feed
- subscription is reusable agent-specific filtering intent

That means multiple agents can share:

- one GitHub host
- one GitHub repo-events stream for `holon-run/agentinbox`
- one GitHub CI stream for `holon-run/agentinbox`

without needing:

- one provider connector instance per agent
- one source type per endpoint

## 5. Creation Order Should Be Explicit

The operational lifecycle should be:

1. create source host
2. create stream under that host
3. create subscription on that stream

This reflects the actual ownership model:

- host owns provider/account/runtime context
- stream owns concrete feed configuration and checkpoint
- subscription owns agent-specific routing/filtering intent

This should be the default mental model in CLI, API, and docs.

## Proposed Shapes

## Host

Suggested shape:

```json
{
  "sourceId": "src_github_default",
  "sourceType": "github",
  "config": {
    "auth": "github-default"
  }
}
```

## Stream

Suggested shape:

```json
{
  "streamId": "stm_repo_events_agentinbox",
  "sourceId": "src_github_default",
  "streamKind": "repo_events",
  "streamKey": "holon-run/agentinbox",
  "config": {
    "owner": "holon-run",
    "repo": "agentinbox"
  },
  "checkpoint": "..."
}
```

CI example:

```json
{
  "streamId": "stm_ci_agentinbox",
  "sourceId": "src_github_default",
  "streamKind": "ci_runs",
  "streamKey": "holon-run/agentinbox",
  "config": {
    "owner": "holon-run",
    "repo": "agentinbox"
  },
  "checkpoint": "..."
}
```

X search example:

```json
{
  "streamId": "stm_x_search_agentinbox",
  "sourceId": "src_x_default",
  "streamKind": "search",
  "streamKey": "query:agentinbox",
  "config": {
    "query": "agentinbox"
  },
  "checkpoint": "..."
}
```

## 5. Capability Discovery Should Be Split Too

The host and stream expose different capabilities.

### Host-Level Schema

Host discovery should answer:

- which provider/runtime this host is
- what auth/config it needs
- which stream kinds it supports

### Stream-Level Schema

Stream discovery should answer:

- what config this stream kind needs
- what metadata fields it emits
- which shortcuts or tracked-resource behaviors it supports
- what lifecycle hooks it projects

Suggested CLI direction:

```bash
agentinbox source schema <sourceId>
agentinbox stream schema <sourceId> <streamKind>
agentinbox stream schema preview <sourceType> <streamKind> [--config-json JSON]
```

The key point is:

- host schema is not enough
- stream schema is where most practical capability discovery belongs

## 6. Mapping To UXC

The recommended split should remain:

### `uxc` owns

- provider auth
- transport
- protocol execution
- long-poll or webhook-capable provider runtime
- low-level provider capability invocation

### `AgentInbox` owns

- source host registry
- stream registry
- stream-specific checkpointing
- stream normalization into inbox items
- subscriptions
- activation
- delivery

The intended correspondence is:

- AgentInbox source host -> one provider/auth/runtime context on top of UXC
- AgentInbox stream -> one concrete feed/watch/query spec executed through that
  context
- AgentInbox subscription -> local agent-specific filtering/delivery intent

This keeps `uxc` focused on capability execution while `AgentInbox` owns the
product event model.

## 7. Checkpoint Ownership Belongs To Streams

Checkpoint state should belong to streams, not hosts and not subscriptions.

### Host should own

- provider runtime state
- auth/config reference
- host lifecycle

### Stream should own

- feed config
- feed identity
- provider cursor/checkpoint
- polling position

### Subscription should own

- filters
- tracked resources
- cleanup policy
- delivery/activation intent

This is essential because different feeds under one host must not share
checkpoint state.

Examples:

- GitHub repo events vs GitHub CI runs
- X home timeline vs X search
- X search for `agentinbox` vs X search for `uxc`

## 8. Compatibility Mapping

Current builtin kinds should not break immediately.

Instead, treat them as compatibility aliases that resolve to:

- host type
- stream kind

Examples:

- `github_repo`
  - host: `github`
  - streamKind: `repo_events`
- `github_repo_ci`
  - host: `github`
  - streamKind: `ci_runs`

This gives a migration path:

- existing CLI/docs keep working
- internals move toward host-plus-stream
- future providers do not need more top-level source kinds

## Why This Fits The Product Boundary

This keeps the current AgentInbox boundary intact.

`AgentInbox` still owns:

- shared source hosting
- concrete feed hosting
- normalization
- subscriptions
- activation
- delivery

What changes is just the precision of the internal and public model.

This model also preserves the core principle:

- provider runtime stays out of agent runtimes
- provider endpoint sprawl stays out of the top-level source-type surface

## Migration Path

## Phase 1

Introduce `stream` internally while preserving current public source kinds.

Map current builtins such as:

- `github_repo`
- `github_repo_ci`

to an internal host-plus-stream representation.

## Phase 2

Add stream registry and stream schema discovery.

Move checkpointing and feed-specific polling state fully onto streams.

Expose the host -> stream -> subscription creation order in CLI and API design.

## Phase 3

Expose smaller host-level source kinds publicly for new providers.

New providers such as `x` should launch on the new model directly:

- one host kind
- many stream kinds

## Open Questions

- should the public term remain `source` plus a new `stream`, or should the
  host itself be renamed publicly
- should host config and stream config be stored in separate tables from the
  start or introduced in stages
- should stream reuse be explicit by `streamKey` or only by normalized config
- how much of stream capability discovery should be surfaced in shortcut/schema
  preview commands initially

## Recommendation

Adopt a three-layer model:

- provider/account host
- concrete stream/feed
- agent-specific subscription

Use compatibility aliases for existing builtin source kinds, but stop treating
every new provider feed as a new top-level source kind.

This gives AgentInbox a scalable model for providers such as GitHub and X
without losing shared hosting, clean activation, or explicit delivery context.
