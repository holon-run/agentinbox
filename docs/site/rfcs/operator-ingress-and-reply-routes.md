---
title: Operator Ingress And Reply Routes
date: 2026-06-22
type: page
summary: Define how AgentInbox bridges provider messages into Holon operator ingress and routes Holon replies back through provider delivery, starting with Feishu.
---

# Operator Ingress And Reply Routes

## Summary

`AgentInbox` should be the transport/control-plane bridge between external
operator channels and Holon agents.

For the first implementation, AgentInbox uses the current Holon contract:

- register an operator transport binding on a Holon agent
- forward inbound operator text to Holon `operator-ingress`
- pass a `reply_route_id` per inbound message
- receive Holon output on an AgentInbox delivery route callback
- send the reply through the provider delivery adapter

Feishu is the first provider integration because AgentInbox already has
Feishu source and delivery support.

## Problem

External IM systems can deliver human operator messages to an agent, but the
agent runtime may not reply synchronously. A single incoming Feishu message can
start a long agent turn, tool calls, waits, or later completion briefs.

Therefore AgentInbox should not model this as one provider webhook request that
expects an immediate response.

It also should not embed Holon runtime semantics into its core data model.
AgentInbox owns provider identity, routing, persistence, and outbound delivery;
Holon owns agent execution.

## Current Holon Contract

Holon currently exposes two relevant control endpoints:

- `POST /control/agents/{agent_id}/operator-bindings`
  - registers a binding with transport, operator actor, callback URL, auth, and
    provider metadata
- `POST /control/agents/{agent_id}/operator-ingress`
  - injects an operator prompt with `text`, `actor_id`, `binding_id`,
    `reply_route_id`, provider refs, correlation fields, and metadata

The reply callback capability is binding-level. Each ingress can select a
specific route using `reply_route_id`.

This RFC intentionally does not require a richer ingress-level `reply_target`
object yet.

## Goals

- route Feishu operator messages into Holon without provider details leaking to
  Holon runtime state
- let Holon replies return through AgentInbox delivery routes
- keep AgentInbox within the product boundary:
  `SourceStream → Interest → InboxItem → Activation → DeliveryHandle`
- preserve provider-neutral core records while allowing provider adapters to
  execute concrete delivery operations
- support asynchronous replies rather than synchronous request/response chat

## Non-Goals

- do not implement agent runtime, task scheduling, or prompt orchestration in
  AgentInbox
- do not require Holon to know Feishu chat IDs or Feishu API details
- do not build a general SaaS automation/workflow platform
- do not require every provider to support operator ingress immediately
- do not replace existing source subscriptions or delivery handles

## Data Model

### OperatorTransportBinding

An `OperatorTransportBinding` connects one AgentInbox-managed transport to one
Holon agent.

It stores:

- `bindingId`
- `agentId`
- `transport` such as `feishu`
- `operatorActorId`
- Holon base URL and optional Holon auth
- optional AgentInbox delivery callback URL and delivery auth
- optional default route id
- capabilities such as `prompt`
- provider and metadata

When requested, AgentInbox syncs the binding to Holon through
`operator-bindings`.

### OperatorReplyRoute

An `OperatorReplyRoute` maps a Holon `reply_route_id` back to an AgentInbox
`DeliveryHandle`.

It stores:

- `routeId`
- `bindingId`
- `agentId`
- `deliveryHandle`
- optional source id and metadata

Holon only needs to preserve the route id. AgentInbox uses that id to recover
the provider target and call the correct delivery adapter.

## Request Flow

### 1. Register binding

An operator or integration creates a binding for an agent:

```text
AgentInbox -> Holon /control/agents/{agent_id}/operator-bindings
```

AgentInbox includes the callback URL template that Holon can call when output
is ready.

### 2. Forward inbound Feishu message

When a Feishu message should act as an operator prompt, AgentInbox:

1. normalizes the operator actor id
2. creates or updates an `OperatorReplyRoute`
3. forwards the text to Holon `operator-ingress`
4. includes `reply_route_id`, `provider_message_ref`, and metadata

Holon accepts the prompt asynchronously and later emits output.

### 3. Deliver Holon reply

Holon calls AgentInbox:

```text
POST /delivery-routes/{route_id}/messages
```

AgentInbox resolves the route to a `DeliveryHandle` and sends the text through
the provider delivery adapter. For Feishu, this currently maps to the canonical
chat message or message reply delivery operation.

## Feishu First Implementation

The first implementation targets Feishu because AgentInbox already supports:

- `feishu_bot` source streams
- Feishu `DeliveryHandle` surfaces
- canonical Feishu text send/reply delivery

The operator route layer should only store provider routing data in the
`DeliveryHandle`; it should not introduce Feishu-specific core tables.

## Open Questions

- Whether Holon should later accept an ingress-level `reply_target` object for
  per-message callback capabilities.
- How callback authentication should be rotated when AgentInbox is deployed as
  a long-running local service.
- Whether route lifecycle cleanup should be tied to source item retention,
  conversation TTL, or explicit operator binding removal.
