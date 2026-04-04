# AGENTS.md

## Purpose

This repository is for `AgentInbox`, the shared ingress and delivery layer for
local agents.

The repository should stay focused on one problem:

`How do outside systems deliver messages and events into local agents, and how do local agents send replies back out, without embedding connector logic into the runtime?`

## Product Boundary

Treat these boundaries as non-negotiable unless a deliberate architecture
decision says otherwise:

- `AgentInbox` owns subscription sources, delivery, and activation
- `Louke` owns runtime semantics, queue meaning, wake/sleep, tasks, and brief
- `holon` is the future assembled product shell, not the inbox core

Do not let `AgentInbox` drift into:

- an agent runtime
- a workflow engine
- a prompt orchestration layer
- a general SaaS automation platform

## Core Model

Default conceptual model:

- `SubscriptionSource`
  - shared source instance, reusable across many agents
- `Interest`
  - agent-specific filter and delivery rule on top of a source
- `InboxItem`
  - normalized inbound item produced by a source
- `Activation`
  - lightweight signal that tells a runtime there is something to read
- `DeliveryHandle`
  - source-specific handle for sending outbound replies or updates

Keep source hosting and runtime interpretation separate.

## Design Principles

### 1. Source First, Agent Second

One source should be able to serve many agents.
Do not design the core around one private connector instance per agent unless a
source explicitly requires it.

### 2. Route First, Abstract Later

Do not force a perfect universal message schema too early.
Prefer:

- unified routing boundary
- small common metadata
- source-specific payloads when necessary

### 3. Delivery Is Part Of The Product

`AgentInbox` is not receive-only.
Outbound delivery is part of the boundary and should be designed as a first-
class concern.

### 4. Keep Runtime Meaning Out

`AgentInbox` can say:

- which source produced an item
- which agent interest matched
- which delivery handle should be used

`AgentInbox` should not decide:

- whether the runtime should sleep or wake
- how tasks are interpreted
- how reasoning proceeds
- what a commitment means in long-term agent memory

### 5. Shared Sources Before Heavy Connector Breadth

The early win is not "many connectors".
The early win is:

- one or two useful sources
- shared across multiple agents
- with clean activation and delivery semantics

### 6. Avoid Connector Gravity

Do not let provider-specific SDK details leak upward into the core model.
Keep adapters at the edge and keep the core vocabulary small.

## Current Expected Integration Pattern

The intended runtime flow is:

1. an agent runtime registers one or more interests
2. `AgentInbox` hosts the needed subscription sources
3. source activity produces normalized inbox items
4. matching interests create activations for target agents
5. the agent runtime reads the items it needs
6. outbound replies, questions, or updates go back through `AgentInbox`

## First-Class Non-Goals

Do not build these by default:

- a general automation builder
- a large internal rule engine
- a hosted cloud control plane
- runtime-owned prompt policies
- end-user dashboard product features inside this repo

## Documentation Discipline

When adding docs:

- explain boundary decisions clearly
- prefer small design notes over giant speculative architecture docs
- document why a source belongs in core versus an adapter
- document what is source-shared versus agent-specific

When changing the core model:

- update this file if the boundary moves
- update `README.md` if the product position changes

## Implementation Bias

Bias toward:

- `TypeScript / Node.js`
- adapter-first edges
- small local daemon/service shape
- explicit source lifecycle
- explicit delivery handles

Avoid premature pressure to:

- rewrite in Rust
- unify every provider at the semantic level
- copy runtime semantics from `Louke`

## Quality Bar

Before introducing a new abstraction, ask:

1. Is this solving shared source hosting?
2. Is this solving activation or delivery?
3. Is this actually runtime logic that belongs in `Louke` instead?
4. Does this abstraction reduce connector duplication across agents?

If the answer to 1, 2, and 4 is no, it probably does not belong here.
