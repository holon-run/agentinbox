# Feishu And Lark

This guide shows how to use `AgentInbox` with a Feishu/Lark bot through UXC.

## Prerequisites

- `agentinbox` installed and running
- `uxc` installed
- a UXC Feishu/Lark credential, for example `feishu-default`
- a Feishu/Lark app with message event permissions such as
  `im:message.group_msg`
- the bot added to the chats where it should receive message events

Register the current runtime first:

```bash
agentinbox agent register
```

## Follow Bot Mentions

For most agent bot workflows, use the global mention template:

```bash
agentinbox follow feishu mentions \
  --agent-id <agentId> \
  --config-json '{"uxcAuth":"feishu-default"}'
```

By default, `AgentInbox` resolves the configured app bot's `open_id` from the
Feishu/Lark credential and follows messages that mention that bot across chats
visible to the app event stream. It does not mean every chat in the tenant. The
app must be allowed to receive those events, and the bot normally needs to be
in the chat.

To follow mentions for another user or bot explicitly, pass `openId`:

```bash
agentinbox follow feishu mentions \
  --agent-id <agentId> \
  --arg openId=<openId> \
  --config-json '{"uxcAuth":"feishu-default"}'
```

## Follow One Chat

If the workflow is intentionally limited to one group, use the chat-scoped
templates:

```bash
agentinbox follow feishu chat \
  --agent-id <agentId> \
  --arg chatId=<chatId> \
  --config-json '{"uxcAuth":"feishu-default"}'
```

```bash
agentinbox follow feishu mention \
  --agent-id <agentId> \
  --arg chatId=<chatId> \
  --arg openId=<botOpenId> \
  --config-json '{"uxcAuth":"feishu-default"}'
```

Feishu/Lark `chat_id` values are API identifiers. Users normally see group
names in the app UI, not `oc_xxx` ids. Resolve them with Feishu/Lark IM tools
before using a chat-scoped follow, or prefer `feishu.mentions`.

## Read, Add Context, And Reply

Read the agent inbox:

```bash
agentinbox inbox read --agent-id <agentId>
```

Feishu/Lark inbox items include:

- `metadata.chatId`
- `metadata.messageId`
- `metadata.mentionOpenIds`
- `deliveryHandle`

Fetch surrounding message context when needed:

```bash
agentinbox source invoke <sourceId> \
  --operation get_message_context \
  --input-json '{"messageId":"<messageId>","chatId":"<chatId>","windowBefore":5,"windowAfter":5}'
```

`get_message_context` is anchored to a specific inbox message. Keep passing the
triggering `messageId` when an agent is adding context for a notification; this
avoids racing against newer messages in the same group.

For unanchored browsing, list the latest messages in a chat instead:

```bash
agentinbox source invoke <sourceId> \
  --operation list_recent_messages \
  --input-json '{"chatId":"<chatId>","limit":20}'
```

Reply with text:

```bash
agentinbox deliver invoke \
  --handle-json '<deliveryHandle-json>' \
  --operation send_text \
  --input-json '{"text":"Acknowledged","uxcAuth":"feishu-default"}'
```

Rich text and files are available through delivery operations such as
`send_post`, `send_file`, and `send_file_from_path`.
