# Source Types

`AgentInbox` v1 uses a host + stream model.

- a host owns shared provider/runtime configuration
- a source/stream binds one concrete feed under that host
- subscriptions stay agent-specific

## Host Types

## `local_event`

`local_event` is the local ingress host. Its canonical stream kind is:

- `events`

Use it when a local producer wants to append events directly into `AgentInbox`
without building a provider-specific adapter first.

## `github`

`github` is the shared GitHub host. Common stream kinds are:

- `repo_events`
- `ci_runs`

Use `repo_events` for issues, issue comments, pull requests, review comments,
and general collaboration activity. Use `ci_runs` for GitHub Actions workflow
state transitions.

Typical canonical registration flow:

```bash
agentinbox host add github uxcAuth:github-default \
  --config-json '{"uxcAuth":"github-default"}'
agentinbox source add <host_id> repo_events holon-run/agentinbox \
  --config-json '{"owner":"holon-run","repo":"agentinbox"}'
agentinbox source add <host_id> ci_runs holon-run/agentinbox \
  --config-json '{"owner":"holon-run","repo":"agentinbox","pollIntervalSecs":30}'
```

Useful normalized `ci_runs` metadata includes:

- `status`
- `conclusion`
- `name`
- `headBranch`
- `headSha`
- `actor`

Typical `ci_runs` subscription filters:

```json
{"status":"completed"}
```

```json
{"status":"completed","conclusion":"failure"}
```

## `feishu`

`feishu` is the shared Feishu host. Its canonical stream kind is:

- `message_events`

It uses `uxc` long-connection subscriptions for inbound messages and `uxc`
OpenAPI delivery for replies.

## `email`

`email` is the shared mailbox host. Its canonical stream kind is:

- `message_events`

One `email_mailbox` source watches one mailbox and can serve many agents;
agents filter by `from`, `subject`, or `threadId` in subscription filters.
Inbound transports are hosted by `uxc` (`email-imap-idle` for IMAP and
`email-provider-poll` for Gmail/Microsoft Graph/JMAP) and normalized onto the
same `email_event` envelope. Outbound replies and new messages go through the
`uxc` daemon `email.send` / `email.reply` RPC over SMTP.

Typical canonical registration flow:

```bash
agentinbox host add email email:imap:user@example.com \
  --config-json '{"uxcAuth":"email-primary"}'
agentinbox source add <host_id> message_events primary \
  --config-json '{"provider":"imap","endpoint":"imaps://imap.example.com:993","uxcAuth":"email-primary","account":"user@example.com","smtpEndpoint":"smtp://localhost:2525","fromAddress":"bot@example.com"}'
```

Credentials never go inline: `uxcAuth` references a `uxc` auth profile that
holds the mailbox credentials. Delivery requires `smtpEndpoint` and a `from`
address (input, source config `fromAddress`, or an address-like `account`).
Binary attachment content never enters inbox items. Public entries expose safe
metadata and an opaque `attachmentRef`; provider retrieval handles remain
internal.

Attachment content is disabled by default. Configure
`attachmentPolicy.mode=store_reference` on the source to allow explicit,
bounded materialization. Policy fields include `maxAttachmentsPerMessage`,
`maxBytesPerAttachment`, `maxBytesPerMessage`, `allowContentTypes`,
`denyContentTypes`, and `retentionSecs`.

### Email first-look backfill depth

`initialFetchLimit` controls how deep the first look into the mailbox goes
when the source is created (integer `0..100`, default `25`):

- `0` — new mail only: existing messages are skipped, and only mail arriving
  after the subscription starts is delivered
- `1..100` — the initial sync emits at most this many of the most recent
  messages; anything older is treated as baseline and never delivered

The setting applies to both transports (`imap` and `gmail`/`graph`/`jmap`
polling). Later polls are unaffected: they always deliver new mail.

Useful normalized `message_events` metadata includes:

- `from` / `fromName` / `to` / `subject` / `textPreview`
- `messageId` / `threadId` / `providerMessageId`
- `hasAttachments` / `attachmentCount` / `attachmentsComplete` / `attachments`

Public attachment entries contain safe metadata and an opaque,
versioned `attachmentRef`. Provider retrieval handles, credentials, and
locators are not exposed. Inspect one attachment without downloading content:

```bash
agentinbox inbox attachment inspect <attachmentRef> --agent-id <agentId>
```

For a `store_reference` source, materialize and save one attachment:

```bash
agentinbox inbox attachment get <attachmentRef> \
  --agent-id <agentId> \
  --output ./attachment.bin
```

The daemon downloads into a bounded staging area and stores an immutable,
content-addressed object. The CLI receives the binary response and creates the
output path exclusively; it does not overwrite an existing file.

`attachmentsComplete=false` distinguishes an unexpanded or partial provider
listing from a message that is known to have no attachments.

## `remote_source`

`remote_source` is the generic host type for custom local modules. Its default
stream kind is:

- `default`

It uses a local module to define:

- managed source spec (`source.ensure`)
- raw event mapping (`stream.read` payload -> AgentInbox event)
- config validation

It may also optionally define capability introspection hooks used by resolved
instance schema discovery:

- `describeCapabilities`
- `listSubscriptionShortcuts`
- `expandSubscriptionShortcut`
- `deriveTrackedResource`
- `projectLifecycleSignal`

Configuration fields:

- `modulePath` (required): path under `$AGENTINBOX_HOME/source-modules`
- `moduleConfig` (optional): module-specific config object

## Resolved Stream Schema

After creating a source/stream, inspect its resolved schema before adding
subscriptions:

```bash
agentinbox source schema <source_id>
```

Builtin GitHub and Feishu streams still expose source-specific metadata fields,
payload examples, shortcuts, and lifecycle hooks through the resolved source
schema. The canonical registration path is the host + stream flow above, not
the old pre-v1 source-kind aliases.
