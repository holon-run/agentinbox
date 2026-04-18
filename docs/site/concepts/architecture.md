# AgentInbox Architecture Baseline

This document defines the initial architecture baseline for `AgentInbox`.

It is intentionally narrow.
The goal is not to design a complete platform up front.
The goal is to lock the boundary between:

- external systems
- shared local subscription and delivery infrastructure
- local agent runtimes

For the next-step event retention and multi-consumer design, see
[Event Bus Backend](./eventbus-backend.md).

## One Sentence

`AgentInbox` is the shared local ingress and delivery layer for agents.

It hosts reusable subscription sources, evaluates agent-specific interests on
top of those sources, stores normalized inbound items, activates local runtimes
when needed, and delivers outbound replies or updates back to external systems.

## Position In The Stack

Current stack interpretation:

- `uxc`
  - capability access layer
- `webmcp-bridge`
  - web/browser bridge layer
- `AgentInbox`
  - shared ingress and delivery layer
- `holon`
  - future assembled product shell / operator environment

This means `AgentInbox` is not optional glue.
It is the system boundary that keeps connector logic out of agent runtimes.

## Primary Architectural Goal

The repository should solve this problem:

`How do multiple local agents reuse the same outside-world subscriptions and delivery paths without embedding provider-specific connector logic inside each runtime?`

## Core Boundary

Use this boundary as the baseline:

- `AgentInbox` owns source hosting, normalization, activation, and delivery
- downstream runtimes own queue meaning, wake/sleep policy, task logic, and
  reasoning

This boundary should stay explicit in code and docs.

## Why `AgentInbox` Exists

Without `AgentInbox`, each runtime or agent tends to absorb:

- GitHub SDK integration
- IM bot/session integration
- MCP client/session wiring
- webhook intake
- callback routing
- message-thread reply logic
- event watcher lifecycle

That creates connector gravity inside the runtime.

`AgentInbox` exists to stop that drift.

## Reuse Of `uxc`

`AgentInbox` should reuse `uxc` as a foundational capability layer.

`uxc` should be treated as the default path for:

- CLI capability execution
- MCP capability access
- OpenAPI / GraphQL / JSON-RPC / gRPC access where appropriate
- unified invocation of external capabilities needed by source adapters or
  outbound delivery adapters

This does not mean `AgentInbox` should delegate all logic to `uxc`.

The separation is:

- `uxc` answers: how to call a capability
- `AgentInbox` answers: how to host a source, track delivery context, normalize
  inbound items, and activate local agents

So the rule is:

- reuse `uxc` for capability execution
- keep source lifecycle and delivery semantics in `AgentInbox`

## Reuse Of `webmcp-bridge`

When a source or outbound surface lives primarily in browser/web-app space,
`AgentInbox` should prefer reusing `webmcp-bridge` rather than building direct
browser/session logic itself.

The separation is:

- `webmcp-bridge` owns browser-side access paths
- `AgentInbox` owns local source hosting and activation/delivery semantics

## Core Objects

The initial model should stay small.

### `SourceStream`

A shared hosted source in the local environment.

Examples:

- GitHub repo event source
- IM conversation source
- MCP-driven message source
- workspace watcher source
- browser/app bridge source

Responsibilities:

- connect to the source
- receive or poll events/messages
- normalize raw input into source-level records
- expose source identity and lifecycle

Non-responsibilities:

- do not own agent runtime state
- do not own task semantics
- do not decide whether a runtime should continue reasoning

### `Interest`

An agent-specific filter and delivery rule on top of a `SourceStream`.

Responsibilities:

- identify which agent cares about which subset of source activity
- define what should trigger activation
- define mailbox and delivery routing metadata

Non-responsibilities:

- do not represent the full user-agent commitment model
- do not become a workflow DSL

### `InboxItem`

A normalized inbound item stored by `AgentInbox`.

Responsibilities:

- preserve source identity
- preserve source-native references needed for reply/update routing
- preserve enough metadata for the runtime to fetch or inspect the item

Note:

An `InboxItem` is not the same thing as a runtime queue item.
The runtime should read inbox items and map them into runtime-specific meaning.

### `Activation`

A lightweight wake signal sent from `AgentInbox` to a runtime.

Responsibilities:

- identify the target runtime or agent
- identify the source/mailbox where new work exists
- provide a lightweight summary or count

Non-responsibilities:

- do not carry full runtime semantics
- do not replace queue items

### `DeliveryHandle`

A source-specific or surface-specific handle for outbound delivery.

Examples:

- GitHub issue comment target
- PR review thread target
- IM thread/conversation target
- MCP/session message target

Responsibilities:

- let the runtime send `reply`, `ask`, `update`, or `notify` without owning the
  provider SDK details

## Inbound Flow

Recommended first-pass inbound flow:

1. runtime or agent registers one or more `Interest` records
2. `AgentInbox` ensures the needed `SourceStream` is hosted
3. source activity produces `InboxItem` records
4. matching interests create `Activation`
5. runtime receives the activation and decides whether/how to read items
6. runtime maps inbox items into its own queue and task semantics

## Outbound Flow

Recommended first-pass outbound flow:

1. runtime decides to send a `reply`, `ask`, `update`, or `notify`
2. runtime references a `DeliveryHandle`
3. `AgentInbox` performs the source-specific delivery
4. source-specific message/thread identity remains in `AgentInbox`, not in the
   runtime connector layer

## Shared Source Model

One important rule:

- sources should be shared
- interests should be agent-specific

That allows:

- one GitHub repo source serving multiple agents
- one IM conversation source serving multiple agents
- one workspace watcher source serving multiple agents

This is a core reason for the product to exist at all.

## Minimal Scope For V1

V1 should prove the boundary, not platform breadth.

Reasonable first-pass scope:

- one or two source types
- activation path into one runtime
- mailbox read path
- one or two outbound delivery surfaces
- shared source hosting across multiple agents

## Non-Goals For V1

Do not build these by default:

- general workflow automation builder
- hosted cloud control plane
- complex rule language
- heavy universal message ontology
- runtime-owned prompt or task semantics
- many connectors before the core boundary is proven

## Architectural Rule Of Thumb

When implementing a feature, ask:

1. Is this source hosting?
2. Is this activation?
3. Is this outbound delivery?
4. Is this actually runtime logic that belongs in the runtime?
5. Is this actually generic capability execution that should be delegated to
   `uxc`?

If the answer to 4 is yes, do not put it in `AgentInbox`.
If the answer to 5 is yes, do not reimplement it in `AgentInbox`.

## Current Implementation Bias

The first implementation should prefer:

- `TypeScript / Node.js`
- edge adapters over core generalization
- route-first abstractions
- source sharing
- small local daemon/service shape

The first implementation should avoid:

- over-unifying provider semantics
- copying downstream runtime concepts into this repo
- turning `AgentInbox` into an all-in-one integration platform
