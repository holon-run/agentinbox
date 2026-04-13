---
title: Source Kinds And Resolved Schemas
date: 2026-04-13
type: page
summary: Separate runtime host types from user-facing source kinds, and make source capability discovery implementation-backed through resolved per-source schemas.
---

# Source Kinds And Resolved Schemas

## Summary

`AgentInbox` should separate:

- runtime host type
- user-facing source kind
- concrete source instance

The immediate reason is the current `remote_source` model.

`remote_source` is a shared runtime host for external sources, but it is not a
useful user-facing type on its own. It becomes concrete only after it is bound
to a builtin or user-defined implementation module.

This RFC proposes:

- keep a small set of internal host/runtime classes
- make source capability discovery operate on resolved source kind, not just
  static `sourceType`
- treat builtin and user-defined remote implementations as one capability model
- make per-source resolved schema the primary discovery surface for agents
- keep old builtin names such as `github_repo` as friendly aliases where useful

## Problem

Today the public model mixes two different concepts into one `sourceType`
surface:

- runtime host class such as `local_event` vs `remote_source`
- product-facing source kind such as `github_repo`

This works for simple builtin sources, but it breaks down once user-defined
remote implementation modules enter the picture:

- `remote_source` is not directly useful until an implementation module is attached
- builtin remote-backed kinds like `github_repo` behave like first-class types
- user-defined remote implementations are currently hidden behind a generic
  `remote_source` shell
- capability discovery for subscription shortcuts or lifecycle behaviors cannot
  be accurately expressed by `source schema <sourceType>` alone

As a result, agents do not have a clear way to ask:

- what kind of source is this instance really
- which normalized metadata fields does it expose
- which subscription shortcuts does it support
- which lifecycle capabilities does it project

## Goals

- separate runtime hosting concerns from user-facing source capability identity
- make builtin and user-defined remote implementations discoverable through one model
- keep builtin source kinds easy to use
- make `sourceId`-scoped resolved schema the primary discovery path
- define how remote implementation modules expose extension hooks and shortcuts

## Non-Goals

- do not remove the shared `remote_source` runtime model
- do not require every source implementation to use the remote module contract
- do not require uploading executable remote module code through the `AgentInbox` API
- do not force an immediate breaking rename of the existing `SourceType` field

## Terms

### Host Type

The runtime class used to host the source.

Examples:

- `local_event`
- `remote_source`

This is primarily an implementation concern used by adapters/runtime routing.

### Source Kind

The user-facing concrete source capability.

Examples:

- `local_event`
- `github_repo`
- `github_repo_ci`
- `feishu_bot`
- `remote:acme.my_profile`

Source kind is what agents should reason about when discovering:

- metadata fields
- event variants
- subscription shortcuts
- lifecycle capabilities

### Source Instance

A registered source record identified by `sourceId`.

This is the concrete object with:

- persisted config
- lifecycle state
- subscriptions
- resolved runtime binding

## Proposed Model

## 1. Keep Runtime Host Types Small

The runtime should continue to reason in terms of a small set of host classes.

Today that effectively means:

- `local_event`
- `remote_source`

Builtin sources such as `github_repo` may remain as compatibility-facing public
types in the short term, but the architecture should treat them as resolved
source kinds hosted by the shared `remote_source` runtime.

## 2. Introduce Resolved Source Kind As A First-Class Discovery Surface

Every source instance should expose a resolved kind identity.

Suggested shape:

```json
{
  "sourceId": "src_xxx",
  "hostType": "remote_source",
  "sourceKind": "github_repo",
  "implementationId": "builtin.github_repo"
}
```

For a user-defined remote implementation:

```json
{
  "sourceId": "src_xxx",
  "hostType": "remote_source",
  "sourceKind": "remote:acme.my_profile",
  "implementationId": "acme.my_profile"
}
```

For `local_event`:

```json
{
  "sourceId": "src_xxx",
  "hostType": "local_event",
  "sourceKind": "local_event",
  "implementationId": "builtin.local_event"
}
```

### Why `implementationId`

`profile` is too narrow as a global concept because only remote-hosted sources
use that mechanism today, and the loaded object is actually an executable
implementation module rather than a declarative profile.

The more general concept is implementation identity:

- remote user-defined source -> implementation id comes from remote module id
- remote builtin source -> implementation id comes from builtin remote module id
- local/native source -> implementation id comes from builtin adapter identity

This keeps the model extensible even if future native source types do not use
the remote module contract.

## 3. Resolved Schema Becomes The Main Agent Discovery Surface

`source schema <sourceType>` should no longer be the primary way an agent learns
how to use a source.

Instead, the main discovery path should be an instance-scoped resolved schema.

Suggested CLI shapes:

```bash
agentinbox source schema <sourceId>
agentinbox source schema preview <sourceKind> [--config-json JSON]
```

The existing type-level schema can remain as a catalog/overview surface, but it
should be clearly secondary.

### Resolved Schema Shape

Suggested shape:

```json
{
  "sourceId": "src_xxx",
  "hostType": "remote_source",
  "sourceKind": "github_repo",
  "implementationId": "builtin.github_repo",
  "aliases": ["github_repo"],
  "configSchema": [],
  "eventSchema": {
    "metadataFields": [],
    "eventVariantExamples": []
  },
  "subscriptionSchema": {
    "supportsTrackedResourceRef": true,
    "supportsLifecycleSignals": true,
    "shortcuts": []
  }
}
```

This is what agents and skills should read before creating subscriptions.

## 4. Builtin Names Should Behave As Friendly Aliases

Builtin remote-backed kinds such as:

- `github_repo`
- `github_repo_ci`
- `feishu_bot`

should remain easy public entry points.

But internally they should be treated as aliases over remote hosted
implementations.

Examples:

- `github_repo` -> host type `remote_source`, implementation
  `builtin.github_repo`
- `github_repo_ci` -> host type `remote_source`, implementation
  `builtin.github_repo_ci`

This preserves the easy path without forcing core architecture to keep two
separate concepts mixed together forever.

## Remote Implementation Contract

For remote-hosted sources, builtin and user-defined implementations should use
one contract.

Current remote implementation hooks already include:

- `validateConfig`
- `buildManagedSourceSpec`
- `mapRawEvent`

This RFC extends that capability model with introspection hooks.

Suggested shape:

```ts
interface RemoteSourceModule {
  id: string
  validateConfig(source: SubscriptionSource): void
  buildManagedSourceSpec(source: SubscriptionSource): ManagedSourceSpec
  mapRawEvent(
    rawPayload: Record<string, unknown>,
    source: SubscriptionSource,
  ): MappedRemoteEvent | null

  describeCapabilities?(
    source: SubscriptionSource,
  ): {
    sourceKind?: string
    aliases?: string[]
    configSchema?: SourceSchemaField[]
    metadataFields?: SourceSchemaField[]
    eventVariantExamples?: string[]
  }

  listSubscriptionShortcuts?(
    source: SubscriptionSource,
  ): SubscriptionShortcutSpec[]

  expandSubscriptionShortcut?(
    input: ExpandSubscriptionShortcutInput,
  ): ExpandedSubscriptionInput | null

  deriveTrackedResource?(
    filter: SubscriptionFilter,
    source: SubscriptionSource,
  ): { ref: string } | null

  projectLifecycleSignal?(
    rawPayload: Record<string, unknown>,
    source: SubscriptionSource,
  ): LifecycleSignal | null
}
```

Not every hook is required immediately.

The important thing is to establish one extensibility surface that:

- builtin remote sources use
- user-defined remote sources use
- resolved schema can expose
- CLI and skills can introspect

## Subscription Shortcuts

Remote-module-defined subscription shortcuts should be discoverable, but they should
not bypass the standard subscription model.

Shortcut expansion should compile down to ordinary fields such as:

- `filter`
- `trackedResourceRef`
- `lifecycleMode`
- `expiresAt`
- cleanup policy fields

This keeps the product model coherent:

- the CLI remains generic
- module-specific ergonomics still exist
- HTTP API can use the same expansion logic
- agents can discover shortcut shapes through resolved schema

### Why Not Arbitrary Module-Owned CLI Flags

We should not let each remote module add custom top-level CLI flags like:

- `--pr`
- `--thread-id`
- `--workflow`

That would fragment the product surface and make skills harder to write.

The extensibility point should be structured shortcut discovery, not ad hoc CLI
grammar.

## User-Defined Remote Modules

User-defined remote modules should remain file-based local extensions in the
current design.

The module code should live under:

- `$AGENTINBOX_HOME/source-profiles/`

Today `AgentInbox` loads them from local disk through `config.profilePath`.
That field name is a compatibility detail, not the target architectural term.
Future API cleanup may rename it to something like `modulePath`.

This RFC does not propose an HTTP API that uploads executable remote module code into
`AgentInbox`.

### Why

- file-based installation matches the current implementation
- it avoids turning `AgentInbox` into a code-distribution service
- it keeps code execution and lifecycle management scoped to the local runtime

If remote installation is needed later, it should be designed as a separate
module packaging/install story, not as a generic upload-code endpoint.

## CLI And API Direction

### Primary Discovery

Agents should use instance-scoped schema:

```bash
agentinbox source schema <sourceId>
```

### Preview Discovery

Before creating a remote user-defined source, the system should support schema
preview:

```bash
agentinbox source schema preview remote:acme.my_profile --config-json '{...}'
```

or an equivalent shape that resolves the implementation before registration.

### Secondary Catalog

Type-level or kind-level schema may remain for:

- docs
- discovery
- listing known builtin kinds

But it should not be the only source of truth for actual source capability.

## Migration Direction

The current model does not need a flag day rewrite.

Suggested migration:

1. keep existing `SourceType` compatibility
2. add resolved fields such as:
   - `hostType`
   - `sourceKind`
   - `implementationId`
3. add `sourceId`-scoped resolved schema
4. move shortcut and lifecycle capability discovery onto the resolved schema
5. gradually demote bare `remote_source` from a user-facing primary kind into a
   lower-level escape hatch

## Open Questions

- should `source schema preview` take `sourceKind`, `sourceType`, or both
- should builtin kinds remain persisted as current enum values forever, or only
  survive as input aliases
- should non-remote native sources eventually expose the same introspection hook
  style through adapters, not just remote modules
