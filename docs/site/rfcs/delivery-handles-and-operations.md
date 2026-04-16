---
title: Delivery Handles And Source-Specific Operations
date: 2026-04-16
type: page
summary: Keep outbound delivery automation in AgentInbox, but stop forcing all providers into one generic send action. Standardize handle routing and source-specific operations instead.
---

# Delivery Handles And Source-Specific Operations

## Summary

`AgentInbox` should keep outbound delivery as a first-class concern, but it
should not force every provider into one generic `deliver send` interaction
model.

The current `deliver send` shape works for sources that have a natural
canonical text send/reply path, but it breaks down for providers such as
GitHub, where “reply” is actually a family of distinct operations with
different semantics and APIs.

This RFC proposes:

- keep `DeliveryHandle` as the routing and provider-context object
- treat outbound execution as `handle + operation`, not just `send`
- make GitHub-style multi-action providers expose source-specific operations
- keep `deliver send` only as a convenience path for canonical text-only
  surfaces
- treat `deliver` as the provider-independent execution surface when a runtime
  or operator wants to avoid provider-specific tooling

## Problem

Today `AgentInbox` has a single outbound entrypoint:

- CLI: `agentinbox deliver send`
- HTTP: `POST /deliveries/send`

The request can either:

- provide a full `deliveryHandle`
- or provide `provider + surface + targetRef`

This works acceptably for sources such as Feishu chat/message reply where the
main operator intent is genuinely:

- send a message
- reply to a message

But it fits GitHub poorly.

For GitHub, a runtime may need to choose among several actions:

- add an issue comment
- add a PR conversation comment
- reply in a review-comment thread
- start a review
- submit a review
- merge a PR
- close or reopen an issue
- add a reaction

These are not one generic “reply”.

Trying to normalize them into a single `send` action creates several problems:

- the abstraction hides important semantic differences
- `deliver send` either becomes too weak or accumulates provider-specific edge
  cases
- the core risks drifting into provider-command semantics instead of routing
  and delivery infrastructure

## Current State

Current outbound delivery consists of:

- `DeliveryHandle`
  - `provider`
  - `surface`
  - `targetRef`
  - optional `threadRef`
  - optional `replyMode`
- one service entrypoint that resolves a handle and calls a provider delivery
  adapter

Today the real provider-side implementations are intentionally narrow:

- GitHub
  - issue/PR comment send
  - review comment thread reply
- Feishu
  - chat message send
  - message reply

This is useful as a first proof that outbound routing belongs in `AgentInbox`,
but it is not yet the right long-term operator model for multi-action sources.

## Goals

- preserve outbound delivery as part of the `AgentInbox` product boundary
- avoid pretending that all providers expose one canonical reply action
- standardize routing and execution framing without flattening provider
  semantics
- keep simple text send convenience for sources where that model is real
- allow source implementations to describe which outbound operations are
  available for a given handle
- keep `AgentInbox deliver` capable enough to work even when provider-native
  tooling is unavailable

## Non-Goals

- do not remove outbound delivery from `AgentInbox`
- do not require one universal cross-provider action vocabulary for every
  provider
- do not turn `AgentInbox` into a workflow engine or provider-specific command
  shell
- do not require every source to support operation discovery on day one

## Design Principles

## 1. Standardize Routing, Not Meaning

The thing `AgentInbox` should standardize is:

- how an outbound action is routed back to the correct provider context
- how a source-specific adapter is invoked
- how attempts are logged and audited

The thing `AgentInbox` should not try to standardize too early is:

- what counts as a “reply” across all systems

This is the same boundary we already apply inbound:

- shared routing boundary
- small common metadata
- source-specific payloads when necessary

## 2. Delivery Handles Stay, But They Are Not The Whole Model

`DeliveryHandle` should remain the stable routing object captured on inbox
items and events.

It should continue to answer:

- which provider owns this outbound path
- which surface this path belongs to
- which target or thread identity should be addressed

But a handle alone is not enough to describe all possible outbound actions for
that provider context.

For multi-action providers, the runtime needs:

- a handle
- a list of supported operations for that handle
- a schema for each operation’s input

## 3. `deliver` Is The Stable Execution Surface

`AgentInbox deliver` should be thought of as:

- an automation execution surface
- a routing and auditing layer
- a stable fallback when the runtime or operator does not want provider SDKs or
  provider-native CLIs

`AgentInbox` should not require a provider-native tool to be installed in order
to complete outbound work.

## Proposed Model

## 1. Keep `DeliveryHandle` As The Provider Context Object

Suggested continuation of the current shape:

```json
{
  "provider": "github",
  "surface": "review_comment",
  "targetRef": "holon-run/agentinbox#110",
  "threadRef": "review_comment:123456789",
  "replyMode": "thread_reply"
}
```

This remains the source-owned opaque-enough execution context.

The important rule is:

- `DeliveryHandle` routes
- operations express intent

## 2. Introduce Source-Specific Delivery Operations

Instead of assuming one generic `send`, a provider may expose operation
descriptors.

Suggested shape:

```json
{
  "handle": {
    "provider": "github",
    "surface": "pull_request",
    "targetRef": "holon-run/agentinbox#110"
  },
  "operations": [
    {
      "name": "add_comment",
      "title": "Add PR Comment",
      "inputSchema": {
        "type": "object",
        "required": ["body"],
        "properties": {
          "body": { "type": "string" }
        }
      }
    },
    {
      "name": "reply_in_review_thread",
      "title": "Reply In Review Thread",
      "inputSchema": {
        "type": "object",
        "required": ["body"],
        "properties": {
          "body": { "type": "string" }
        }
      }
    },
    {
      "name": "submit_review",
      "title": "Submit Review",
      "inputSchema": {
        "type": "object",
        "required": ["event"],
        "properties": {
          "event": { "type": "string", "enum": ["COMMENT", "APPROVE", "REQUEST_CHANGES"] },
          "body": { "type": "string" }
        }
      }
    }
  ]
}
```

These operations are source-specific.

Core does not need to know what `submit_review` means beyond:

- the source adapter declared it
- this handle supports it
- the adapter can execute it

## 3. Keep `deliver send` Only For Canonical Text Surfaces

Some sources really do have a natural canonical text action:

- Feishu message reply
- chat send
- future email reply
- future SMS send

For those sources, `deliver send` remains useful.

Suggested rule:

- if a handle exposes one canonical text send/reply capability, `deliver send`
  may remain as a convenience alias
- otherwise, callers should use operation discovery plus invoke

Examples where `deliver send` remains a good fit:

- reply to one IM message
- send one text message into one chat

Examples where it should not be the primary operator model:

- GitHub PR review workflows
- issue triage actions
- provider actions that are not text-message shaped

## 4. Add Operation Discovery And Invocation

Suggested CLI direction:

```bash
agentinbox deliver actions --item <itemId>
agentinbox deliver actions --handle-json '{...}'
agentinbox deliver invoke --handle-json '{...}' --operation add_comment --input-json '{"body":"..."}'
```

Suggested HTTP direction:

- `POST /deliveries/actions`
- `POST /deliveries/invoke`

This keeps one generic execution frame while letting providers keep their own
action vocabulary.

## 5. Source-Specific Tool Choice Stays Outside Core

An agent may still choose to use:

- a provider-native CLI
- direct provider API calls
- `AgentInbox deliver`

That choice belongs to the agent/operator layer, not to the `AgentInbox` core
contract.

The only thing the RFC requires is:

- `AgentInbox deliver` must remain sufficient on its own
- provider-native tooling must be optional, not assumed

## Operator Experience

The intended operator split becomes:

### Any Runtime Or Operator

Use `AgentInbox` for:

- handle-based routing
- source-specific operation invocation
- audit logging of outbound attempts
- sources without provider-native tooling
- environments where provider-native tooling is intentionally not used

## Why This Fits The Product Boundary

This direction keeps the `AgentInbox` boundary clean:

- outbound delivery remains in product scope
- adapters still own provider-specific execution
- runtimes do not need provider SDK details
- core does not take on full provider semantic normalization

It also avoids connector gravity:

- GitHub semantics stay in the GitHub edge adapter or operator tool
- core only owns handle routing, execution framing, and attempt logging

## Migration Path

## Phase 1

Keep current `deliver send` intact.

Document it as:

- canonical-text-surface convenience

## Phase 2

Add operation discovery and invocation framing:

- `deliver actions`
- `deliver invoke`

Implement it first for one provider where the difference is valuable, likely
GitHub.

## Phase 3

Teach inbox items and docs to expose better operation guidance while keeping
AgentInbox operation descriptors available for automation.

## Open Questions

- should operation discovery live on the handle, the source kind, or both
- should operation descriptors be exposed on inbox items directly or only
  through a lookup endpoint
- should `deliver send` hard-error when a handle has multiple non-canonical
  operations, or only warn

## Recommendation

Adopt the following product rule:

- `DeliveryHandle` remains the outbound routing primitive
- `deliver send` remains only for canonical text reply/send surfaces
- multi-action providers should move toward `handle + operation`
- provider-native tools should be optional, not required
- `AgentInbox deliver` should remain sufficient as a standalone execution path

This gives `AgentInbox` a stable delivery model without forcing a fake universal
reply abstraction across providers.
