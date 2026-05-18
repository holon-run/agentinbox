---
title: IM Agent Interaction Model
date: 2026-05-18
type: page
summary: Define how AgentInbox should model IM reminders, on-demand context fetching, and feedback operations, with Feishu/Lark as the first implementation case.
---

# IM Agent Interaction Model

## Summary

`AgentInbox` should model IM integrations as three separate capabilities:

- durable reminder subscriptions
- on-demand context fetching
- feedback and reply operations

For IM providers such as Feishu/Lark, the provider usually exposes an app-level
message event stream rather than a separate provider-side subscription for each
chat or mention target. `AgentInbox` should keep that provider stream shared,
then represent chat-level and mention-level interest as agent-specific
subscriptions.

When an agent receives an IM reminder, the inbox item should include enough
stable anchors to fetch more context later, but it should not eagerly store the
whole chat window. Context fetching should be an explicit source-specific read
operation routed through `AgentInbox` and backed by UXC provider credentials.

The first implementation target is Feishu/Lark.

## Problem

The desired user experience is:

1. an agent follows a group mention
2. someone mentions the agent in a group
3. the agent receives a concise reminder
4. the agent asks for message context before responding
5. the agent replies in the right place

This does not fit cleanly into a single "message received" event.

If the inbox item stores only the mention event, the agent lacks enough context
to answer well. If the inbox item eagerly stores a large chat window, the source
will do unnecessary provider reads, create large inbox entries, and make the
subscription path depend on runtime-specific reasoning needs.

There is also a product-boundary question. Agents can call provider CLIs such as
`lark-cli`, but making that the normal path leaks provider tooling, credentials,
and output shape into every agent runtime.

## Goals

- make IM reminders first-class without turning each chat into a private source
- keep provider credentials and API access behind UXC-backed source modules
- let agents fetch context only when they need it
- expose stable, structured context data instead of provider CLI output
- preserve delivery and feedback as `DeliveryHandle` plus source-specific
  operations
- make Feishu/Lark the first case without hardcoding Feishu/Lark semantics into
  the core
- keep `lark-cli` useful for development, debugging, and smoke testing, not as
  the required runtime contract

## Non-Goals

- do not make `AgentInbox` an IM client
- do not build a general chat UI or conversation memory layer
- do not copy all provider messages into AgentInbox by default
- do not require every IM provider to expose identical event or context APIs
- do not let agents directly manage provider credentials
- do not make `lark-cli` the product contract for agents

## Terms

### IM Host

A provider account or app identity that can receive and send IM events.

For Feishu/Lark this is the app/bot identity configured in UXC.

### IM Message Stream

A shared source stream of provider message events.

For Feishu/Lark this maps to app-level `im.message.receive_v1` event
consumption. It is not scoped to one chat.

### Reminder Subscription

An agent-specific interest over a shared IM message stream.

Examples:

- messages in chat `oc_xxx`
- messages in chat `oc_xxx` that mention open id `ou_xxx`
- direct messages to the bot

### Context Anchor

Stable metadata on an inbox item that lets a source module fetch context later.

Examples:

- `chatId`
- `messageId`
- `messageType`
- `senderOpenId`
- `occurredAt`
- `threadId`
- `parentId`
- `rootId`

### Context Operation

A source-specific read operation that uses a context anchor to fetch nearby
messages, thread messages, or message details.

### Feedback Operation

A source-specific write operation that sends a reply, reaction, acknowledgement,
or follow-up message through the provider.

## Conceptual Model

IM integrations should split the interaction into three planes.

### 1. Reminder Plane

The reminder plane decides which provider events become agent-visible inbox
items.

This is normal `AgentInbox` source and subscription behavior:

- a shared source receives provider events
- source mapping extracts normalized metadata
- subscriptions match on metadata and payload
- matching items are delivered to the agent inbox
- activations notify the runtime

The reminder plane should stay cheap and deterministic. It should not fetch a
large context window on every event.

### 2. Context Plane

The context plane answers: "What does the agent need to know before responding?"

It should be explicit and on demand. A runtime or operator should be able to ask
for context using either:

- an inbox item id
- a delivery/context handle
- explicit provider anchors such as `chatId` and `messageId`

The source module should decide the provider-specific retrieval strategy.

For an IM provider, the module may:

- fetch the anchor message
- fetch a thread if the message is in a thread
- fetch a bounded chat window around the anchor message
- fetch sender or participant display data when useful

The return shape should be stable AgentInbox JSON, not raw CLI text.

### 3. Feedback Plane

The feedback plane sends provider-visible output.

This should reuse the existing delivery direction:

- inbox items expose or preserve a `DeliveryHandle`
- source modules expose operation descriptors for available actions
- callers execute `handle + operation + input`

For IM providers, common operations include:

- reply to the anchor message
- reply in thread
- send a chat message
- add a reaction
- mark or acknowledge if the provider supports it

## Reminder Subscriptions

Source modules should expose follow templates for common IM intents.

Illustrative examples:

```bash
agentinbox follow im chat --arg chatId=oc_xxx
agentinbox follow im mention --arg chatId=oc_xxx --arg openId=ou_agent
agentinbox follow feishu mention --arg chatId=oc_xxx --arg openId=ou_agent
```

The compiled subscription should use normal filter semantics.

Example mention filter:

```json
{
  "metadata": {
    "chatId": "oc_xxx"
  },
  "expr": "contains(metadata.mentionOpenIds, \"ou_agent\")"
}
```

The exact metadata fields are source-specific, but IM source modules should
prefer a common vocabulary where provider data allows it:

- `provider`
- `chatId`
- `chatType`
- `messageId`
- `messageType`
- `senderId`
- `senderOpenId`
- `mentions`
- `mentionOpenIds`
- `content`
- `threadId`
- `parentId`
- `rootId`

## Context Handles

An IM inbox item should preserve enough information to fetch context later.

The minimal handle shape should be source-specific but predictable:

```json
{
  "provider": "feishu",
  "surface": "message_context",
  "targetRef": "om_xxx",
  "threadRef": "omt_xxx",
  "chatId": "oc_xxx",
  "occurredAt": "2026-05-18T06:00:00.000Z"
}
```

The existing `DeliveryHandle` is write-oriented. `AgentInbox` may either add a
separate `contextHandle` field or derive a context handle from existing item
metadata and raw payload. The important contract is that the source module owns
provider-specific context retrieval.

## Context Operations

Source modules should expose read operations separately from delivery
operations.

A minimal IM context operation can be:

```json
{
  "name": "get_message_context",
  "inputSchema": {
    "type": "object",
    "required": ["messageId"],
    "properties": {
      "messageId": { "type": "string" },
      "chatId": { "type": "string" },
      "threadId": { "type": "string" },
      "windowBefore": { "type": "number" },
      "windowAfter": { "type": "number" }
    }
  }
}
```

The output should separate the anchor from retrieved context:

```json
{
  "anchorMessage": {
    "messageId": "om_xxx",
    "chatId": "oc_xxx",
    "senderId": "ou_xxx",
    "content": "Can you check this?",
    "createdAt": "2026-05-18T06:00:00.000Z"
  },
  "threadMessages": [],
  "chatWindowMessages": [],
  "deliveryHandle": {
    "provider": "feishu",
    "surface": "message_reply",
    "targetRef": "om_xxx"
  }
}
```

Provider-specific raw responses may be included under a debug or raw field, but
the normal agent path should consume the normalized shape.

## Proposed UX

Low-level operation:

```bash
agentinbox source invoke src_xxx --operation get_message_context \
  --input-json '{"messageId":"om_xxx","chatId":"oc_xxx","windowBefore":20,"windowAfter":5}'
```

Inbox-item oriented convenience:

```bash
agentinbox inbox context itm_xxx --before 20 --after 5
```

The inbox-oriented command should:

1. read the item
2. resolve the source and context anchor
3. call the source context operation
4. return normalized context JSON

This keeps agents from needing provider-specific CLI knowledge for the common
path.

## Feishu/Lark Case

Feishu/Lark should be the first implementation.

### Runtime Boundary

Credentials should live in UXC auth profiles. `AgentInbox` should store the
UXC auth reference, source routing config, and subscription filters.

`lark-cli` is useful for:

- API exploration
- manual smoke testing
- comparing response shapes
- temporary operational fallback

It should not be the normal agent-facing runtime contract.

### Event Source

The shared source should consume the app-level message event stream.

For Feishu/Lark, `lark-cli event schema im.message.receive_v1` shows that the
event exposes useful anchors such as:

- `chat_id`
- `chat_type`
- `message_id`
- `message_type`
- `sender_id`
- `content`
- `create_time`

The provider event does not expose a chat-scoped event subscription parameter,
so "follow this chat" and "follow mentions in this chat" belong in
`AgentInbox` subscription filters.

### Context Retrieval

The Feishu/Lark source module should implement `get_message_context`.

The retrieval strategy should be:

1. fetch or hydrate the anchor message by `messageId`
2. if the message has a thread or topic id, fetch thread messages
3. otherwise fetch a bounded chat window around the message creation time
4. normalize messages into a stable message list

Useful provider capabilities observed in `lark-cli`:

```bash
lark-cli im +messages-mget --message-ids om_xxx --as bot
lark-cli im +threads-messages-list --thread om_xxx --as bot
lark-cli im +chat-messages-list --chat-id oc_xxx --start ... --end ... --sort asc --as bot
```

The production implementation should call the same Lark APIs through UXC,
using the source's UXC auth profile.

### Feedback

The existing Feishu delivery path already supports:

- reply to message
- send chat message

The Feishu module should continue to expose those as delivery operations.

Future feedback operations may include:

- reply with rich text
- reply in thread
- send interactive card
- add reaction

## Core Changes

The core does not need to understand IM semantics.

It should only need generic extension points:

- source modules can describe read/context operations
- source modules can invoke read/context operations
- inbox items can preserve or derive context anchors
- CLI and HTTP can route context operation calls

This parallels the existing delivery operation model without treating reads as
deliveries.

## Implementation Plan

1. Define source-module hooks for read/context operation discovery and
   invocation.
2. Add a Feishu/Lark `get_message_context` operation.
3. Add an inbox-item oriented context command.
4. Add Feishu/Lark follow templates for `chat` and `mention`.
5. Add tests for filter expansion, context operation invocation, and normalized
   output shape.
6. Add a Feishu/Lark user guide after the developer boundary is settled.

## Open Questions

- Should `contextHandle` be stored on inbox items, or derived from
  metadata/raw payload at read time?
- Should source read operations share the same descriptor schema as delivery
  operations with a different operation category?
- How should context reads be logged for audit and rate-limit visibility?
- Should context fetch results be cached, and if so, should the cache live in
  `AgentInbox` or in the source runtime layer?
- What is the minimum normalized IM message schema that works across Feishu,
  Slack, Discord, and Telegram without overfitting?

## Decision

Adopt the following product boundary:

- IM event streams are shared sources.
- Chat and mention tracking are agent-specific reminder subscriptions.
- Message context is fetched on demand through source-specific read operations.
- Replies and other provider-visible actions use delivery operations.
- Provider CLIs such as `lark-cli` are development and fallback tools, not the
  normal agent product contract.
