---
title: X Pay-Per-Use Sources
date: 2026-04-19
type: page
summary: Evaluate X pay-per-use API as an AgentInbox source host, define viable stream kinds, and recommend a staged rollout.
---

# X Pay-Per-Use Sources

## Summary

`X` is now viable as an `AgentInbox` host without committing to the old
subscription-package model.

The official docs now describe the X API as pay-per-usage with upfront credits,
per-endpoint pricing, 24-hour deduplication, and a monthly cap on pay-per-use
Post reads. That is enough to support a first `x` host in `AgentInbox`, but we
should be selective about which stream kinds we expose first.

Tracking issue:

- `#162` `research: phase an x host around pay-per-use source kinds`

The strongest first source is still a shared public stream:

- `filtered_stream`

The most credible follow-up pull sources are:

- `recent_search`
- `full_archive_search`
- `user_posts`
- `user_mentions`

User-bound or webhook-heavy sources are possible, but should come later:

- `home_timeline`
- `liked_posts`
- `bookmarks`
- `account_activity`
- `activity`

We should not model raw `webhooks` as a source kind. In the X docs, webhooks are
delivery infrastructure used by specific products such as Account Activity, X
Activity, and Filtered Stream webhook delivery.

## What The Official Docs Confirm

As of 2026-04-19, the official docs state:

- X API uses pay-per-usage pricing with no monthly subscription commitment
  beyond prepaid credits.
- Pricing is endpoint-specific and current rates live in the Developer Console,
  not in the public docs.
- Pay-per-use usage is tracked at the app level with a monthly cap of 2 million
  Post reads.
- Billable resources are deduplicated within a 24-hour UTC window.
- The usage API can be queried programmatically to track consumption.

This matters for `AgentInbox` because it means an X host can be designed around:

- shared app credentials at the host level
- stream-specific checkpoints and cursors
- explicit cost-aware stream choices
- runtime-visible usage telemetry for operational guardrails

## Important Product Implications

## 1. X Fits The Host + Stream Model Well

The current repository direction is already moving toward:

- provider host
- concrete stream under that host
- agent-specific subscription on top

`X` is a strong fit for this structure because one developer app can back many
different feed shapes with different polling or streaming semantics.

Recommended host kind:

- `x`

Recommended high-level auth variants under the host:

- app-only bearer auth for public read/search/stream sources
- user-context auth for personalized or private feeds
- webhook registration secrets for push-based activity products

## 2. Cost Is Part Of Source Design

For X, source selection is not just a transport question. It is also a cost
question.

The same user need can often be implemented in multiple ways:

- `filtered_stream` for near-real-time public matching
- `recent_search` for low-complexity polling over the last 7 days
- `account_activity` for owned-account push events

Those options have different:

- latency
- operational complexity
- authentication requirements
- billing behavior

So the source catalog should expose deliberate stream kinds instead of a generic
`x_query` abstraction.

## Candidate Stream Kinds

## P0: public shared streams

### `filtered_stream`

Why it should be first:

- closest fit to `AgentInbox`'s ingress model
- near-real-time delivery
- one shared rule set can serve many agents through subscriptions
- official docs explicitly show pay-per-use support

Operational shape:

- one `SourceStream` per rule set or managed stream definition
- host owns app credentials
- stream owns rules, connection state, reconnect policy, and checkpoint
- subscriptions filter on normalized metadata after ingestion

Expected stream config:

- `rules`
- `expansions`
- `tweetFields`
- `userFields`
- `mediaFields`
- optional delivery mode: persistent connection first, webhook later if needed

Recommended normalized metadata:

- `postId`
- `authorId`
- `authorUsername`
- `conversationId`
- `lang`
- `isReply`
- `isRetweet`
- `matchedRules`
- `createdAt`

Design note:

Because pay-per-use filtered stream allows one connection and up to 1,000 rules
in the public docs, this is best treated as a shared host-managed stream rather
than a per-agent connector.

### `recent_search`

Why it belongs in the catalog:

- simple pull-based source
- lower integration risk than persistent streaming
- good for low-frequency monitors and scheduled triage
- available to all developers, so it is a safe baseline

Operational shape:

- poll `GET /2/tweets/search/recent`
- checkpoint by newest seen Post ID or timestamp window
- map search query to a shared stream key

Best use cases:

- keyword tracking
- brand or repo mention polling
- scheduled research feeds
- fallback when `filtered_stream` is unnecessary

### `full_archive_search`

Why it should exist but not be first:

- powerful for backfill and historical bootstrap
- pay-per-use explicitly includes full-archive search
- more likely to be cost-sensitive than recent search

Recommended role:

- first-class source kind only if we need durable historical ingestion
- otherwise keep as a backfill helper for future stream bootstrap workflows

## P1: public user-oriented pull streams

### `user_posts`

Why it is useful:

- direct way to follow one account's authored Posts
- simple checkpoint semantics with `since_id`
- natural fit for "watch this account" subscriptions

Good first-party use cases:

- follow product or org accounts
- monitor release channels
- watch owned bot accounts

### `user_mentions`

Why it is useful:

- more direct than broad search for owned-account mention workflows
- natural fit for agent inboxes that need to respond to mentions
- simpler and cheaper than full account activity if mention monitoring is the
  only requirement

Important limit:

- official docs describe the mentions timeline as capped to the most recent 800
  mentions

### `list_posts`

Possible but lower priority:

- appears in usage tracking docs as a billable tracked endpoint
- good fit for curated watchlists
- not required for a strong v1 X host

I would keep this out of the first implementation unless a concrete product need
appears.

## P2: user-context personalized streams

### `home_timeline`

This is a real candidate source, but not an early one.

Reasons to defer:

- requires user authentication
- personalized feed semantics are runtime-sensitive and less reusable across
  agents
- less aligned with the "shared source before private connector" principle

This should only be added when we explicitly want personal-assistant style
inboxing of a user's own X feed.

### `liked_posts`

Possible as a user-bound pull source:

- can represent "watch what this account liked"
- more niche than posts or mentions
- likely lower reuse value than public feeds

This should not be in the first rollout.

### `bookmarks`

Possible but should be treated as private, user-scoped data:

- requires user-context auth
- only useful for a narrow personal workflow
- fits `AgentInbox` technically, but not as an early shared-source priority

This is a valid later source, especially for "saved for later" assistant
workflows.

## P3: push products with webhook complexity

### `account_activity`

Why it is attractive:

- real-time owned-account events
- richer than mentions or posts alone
- includes Posts, mentions, replies, follows, likes, DMs, and more

Why it should not be first:

- webhook registration and CRC validation add operational complexity
- pay-per-use docs show a very small self-serve limit: 3 unique subscriptions
  and 1 webhook
- this is better for owned-account automation than for broad public monitoring

Product fit:

- strong later source for account-linked agent assistants
- poor first source for a shared multi-agent public monitoring layer

### `activity`

Why it is interesting:

- more event-oriented than timeline/search sources
- supports persistent stream and webhook delivery
- can cover profile, follow, spaces, DM, chat, and news events

Why it is risky:

- it is operationally more specialized than the source shapes we need first
- it pulls `AgentInbox` toward event-bus complexity before we validate core X
  usage

This should stay behind `filtered_stream` and `account_activity`.

## What We Should Not Model As Sources

These do not look like primary `AgentInbox` source kinds:

- raw `webhooks`
- write operations such as like, unlike, bookmark, or post creation
- single-object lookup endpoints such as post lookup or user lookup

Reason:

- webhooks are a transport used by real products, not a domain source on their
  own
- write actions belong on `DeliveryHandle` or provider-specific operations
- one-off lookup endpoints are helpers, not long-lived ingress streams

## Recommended Stream Catalog

Recommended `x` host stream kinds:

| Priority | Stream kind | Access style | Auth shape | Why |
| --- | --- | --- | --- | --- |
| P0 | `filtered_stream` | push or long-lived stream | app auth | best real-time shared public source |
| P0 | `recent_search` | polling | app auth | simplest low-risk source |
| P1 | `full_archive_search` | polling/backfill | app auth | historical bootstrap and research |
| P1 | `user_posts` | polling | app auth | follow a specific account |
| P1 | `user_mentions` | polling | app auth or user auth | mention-centric monitoring |
| P2 | `home_timeline` | polling | user auth | personalized private feed |
| P2 | `liked_posts` | polling | user auth | niche user-bound signal |
| P2 | `bookmarks` | polling | user auth | private saved-items workflow |
| P3 | `account_activity` | webhook push | app auth + webhook | owned-account automation |
| P3 | `activity` | stream or webhook | app auth + filters | specialized event products |

## Recommended Delivery And Normalization Strategy

For the first `x` host, we should keep the normalization boundary narrow.

Shared envelope fields should include:

- `provider = x`
- `streamKind`
- `nativeId`
- `occurredAt`
- `deliveryHandle` when reply or follow-up is possible

Source-specific payloads should remain source-specific.

Examples:

- `filtered_stream` and search/timeline sources can emit normalized Post items
  with source-specific raw payload preserved
- `account_activity` should preserve activity-type groupings instead of forcing
  everything into a fake universal message schema
- `activity` should preserve the event name and filtered user identity

This keeps `AgentInbox` on its boundary:

- ingress, routing, activation, delivery handle capture

Not:

- X-specific workflow interpretation

## Recommended Rollout

## Phase 1

Implement:

- `x` host
- `filtered_stream`
- `recent_search`

Why:

- validates shared-host architecture
- gives both real-time and polling modes
- covers the highest-value public monitoring use cases

## Phase 2

Add:

- `user_posts`
- `user_mentions`
- optional `full_archive_search` for backfill/bootstrap

Why:

- account-specific monitoring becomes straightforward
- mention-based agent workflows become possible without webhook complexity

## Phase 3

Evaluate:

- `account_activity`
- `activity`
- `home_timeline`
- `bookmarks`

Why:

- these are either user-private, webhook-heavy, or operationally specialized

## Risks And Open Questions

## 1. Public Pricing Is Incomplete

Official docs confirm pay-per-use exists, but they do not publish a stable
public per-endpoint rate card. Current rates live in the Developer Console.

Implication:

- source admission should assume pricing can change without docs diffs
- we should expose cost guidance in source docs, not hardcode price math into
  the product model

## 2. There Is Documentation Ambiguity Around Webhook Availability

The generic Webhooks API docs present webhook infrastructure as a shared layer,
while product pages vary in how they describe pay-per-use versus enterprise
availability.

Implication:

- before implementing `account_activity` or `activity`, verify access in a real
  pay-per-use app instead of trusting docs alone

## 3. The Reported 2026-04-20 Price Drop Was Not Independently Verified Here

During this research pass, I confirmed the current official pay-per-use model,
but I did not find a public official doc page that explicitly states a
2026-04-20 price reduction date.

Implication:

- treat the pricing model as confirmed
- treat the exact 2026-04-20 change details as still needing console or
  announcement verification

## Recommendation

Create an `x` host, but keep the first implementation narrow:

- first ship `filtered_stream`
- pair it with `recent_search`
- add `user_posts` and `user_mentions` next
- defer webhook-heavy and user-private sources until the first public sources
  are stable

This aligns with the repository boundary:

- shared source hosting first
- clear delivery and activation semantics
- no premature drift into personal runtime behavior or provider-specific
  workflow logic

## Official References

- X pricing:
  `https://docs.x.com/x-api/getting-started/pricing`
- X usage and billing:
  `https://docs.x.com/x-api/fundamentals/post-cap`
- Filtered stream:
  `https://docs.x.com/x-api/posts/filtered-stream/introduction`
- Search overview:
  `https://docs.x.com/x-api/posts/search/introduction`
- Timelines overview:
  `https://docs.x.com/x-api/posts/timelines/introduction`
- Timelines integration guide:
  `https://docs.x.com/x-api/posts/timelines/integrate`
- Bookmarks:
  `https://docs.x.com/x-api/posts/bookmarks/introduction`
- Likes:
  `https://docs.x.com/x-api/posts/likes/introduction`
- Account Activity:
  `https://docs.x.com/x-api/account-activity/introduction`
- X Activity:
  `https://docs.x.com/x-api/activity/introduction`
- Webhooks:
  `https://docs.x.com/x-api/webhooks/introduction`
