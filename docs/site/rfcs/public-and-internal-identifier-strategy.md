---
title: Public And Internal Identifier Strategy
date: 2026-04-18
type: page
summary: Replace long prefix_uuid identifiers with canonical short IDs, keep only sequence and revision as numeric ordering fields, and align fresh v1 databases on one identifier scheme before release.
---

# Public And Internal Identifier Strategy

## Summary

Before v1 release, `AgentInbox` should stop using long `prefix_uuid`
identifiers for durable records and move to one canonical short-ID scheme.

This is a pre-release cleanup, not a compatibility exercise.

The intended outcome is:

- fresh v1 databases create only short canonical IDs
- pre-v1 local databases remain handled by the reset/archive boundary from
  `#139/#140`
- there is no requirement to preserve old long-form `prefix_uuid` IDs
- `entryId` and `threadId` also become canonical stored string IDs instead of
  integer-only database keys with formatted boundary wrappers

After this change, the repository should use only two identifier styles:

- readable generated names for `agentId`
- short prefixed string IDs for every other durable identifier

Numeric fields remain only where they are truly ordering or revision fields,
such as `sequence`, `revision`, and event offsets.

## Problem

Today the repository mixes several identifier schemes:

- long `prefix_uuid` strings for most durable rows
- integer-backed `ent_<n>` and `thr_<n>` refs for inbox entries and digest
  threads
- a few user-supplied IDs such as explicit `agentId`

That has several costs:

- verbose CLI and HTTP payloads
- worse readability in logs, tests, docs, and LLM workflows
- extra token cost for agents
- no single answer to “what form should a new durable ID take?”

Because v1 has not yet shipped, this is the right time to cleanly reset the
identifier rules instead of preserving pre-release compatibility.

## Goals

- define one canonical ID scheme for fresh v1 databases
- shorten durable IDs used in CLI, HTTP, docs, tests, and agent workflows
- make database storage shape match public API shape for durable IDs
- keep explicit user-supplied `agentId` support
- remove UUID-backed durable IDs from normal product paths

## Non-Goals

- do not preserve compatibility with old long-form `prefix_uuid` IDs
- do not add alias tables or dual-ID support
- do not change provider-native identifiers such as `DeliveryHandle.targetRef`
- do not turn ordering fields such as `sequence` into string IDs

## Core Design

## 1. Fresh v1 Databases Use The New Scheme Only

`#139/#140` already defined the storage reset boundary for pre-v1 data.

That means this RFC can be simpler:

- pre-v1 local databases are outside the compatibility boundary
- fresh v1 databases should be created directly with the new identifier scheme
- there is no requirement to support in-place rewrite of released v1 databases

This RFC therefore defines the canonical ID rules for the database shape that
ships as v1.

## 2. Canonical Prefix Table

The repository should standardize on these canonical prefixes:

- `agt_` agent
- `inb_` inbox
- `hst_` source host
- `src_` source stream
- `sub_` subscription
- `tgt_` activation target
- `sch_` timer schedule
- `str_` event-bus stream
- `itm_` inbox item
- `act_` activation
- `dlv_` delivery
- `evt_` stream event
- `con_` consumer
- `cmt_` consumer commit
- `ent_` inbox entry
- `thr_` digest thread

This is not just documentation. The code should be updated to use these
prefixes consistently.

In particular, this RFC intentionally changes current implementation prefixes
such as:

- `sched` -> `sch`
- `item` -> `itm`
- `strevt` -> `evt`
- `commit` -> `cmt`

## 3. Agent IDs Use Readable Names

`agentId` is the one durable identifier that should default to a readable name
instead of a random token.

Default generated shape:

- `agt_<word>-<word>`

Example:

- `agt_copper-fox`

Generation rules:

- lowercase words only
- two-word combination from a fixed word list
- collisions resolved by regeneration
- if repeated collisions exceed a fixed retry budget, fall back to:
  - `agt_<word>-<word>-<short>`

This preserves:

- readability in logs and CLI
- short references for humans and agents
- deterministic conflict handling

Explicit user-supplied `agentId` remains supported and is not rewritten.

## 4. All Other Durable IDs Use Short Random Tokens

All other durable identifiers should use one short-token family:

- `prefix_<token>`

Recommended token properties:

- lowercase only
- visually conservative alphabet
- fixed length
- collision handling via regenerate-and-retry

Examples:

- `src_7k2f9m3qw1bx`
- `sub_d4n8xr1w6pqt`
- `itm_b6tj4r8pm2vk`
- `ent_m7q4x2p9d8rv`

The exact token generator can be an implementation choice, but the product rule
is:

- all non-agent durable IDs are short canonical strings with the stable prefix
  vocabulary above

## 5. Database Storage Matches Public Shape

Durable IDs should be stored in the database exactly as they are exposed through
CLI and HTTP.

That means:

- `source_id` stores `src_<token>`
- `subscription_id` stores `sub_<token>`
- `entry_id` stores `ent_<token>`
- `thread_id` stores `thr_<token>`

The repository should no longer maintain a special “integer in DB, prefixed ref
at the boundary” path for durable IDs.

This simplifies:

- SQL inspection
- joins and debugging
- JSON payload persistence
- documentation and tests

## 6. Entry And Thread Keep Numeric Ordering Fields, Not Numeric IDs

`InboxEntry` and `DigestThread` no longer need special integer identity rules.

Instead:

- `entryId` is a canonical string ID: `ent_<token>`
- `threadId` is a canonical string ID: `thr_<token>`

If ordering is needed, keep it in dedicated numeric fields:

- `inbox_entries.sequence`
- `inbox_entries.revision`
- stream/event offsets

This preserves the useful part of the current design:

- stable numeric order and ack boundaries

without preserving the confusing part:

- durable IDs whose stored database shape differs from their public form

## 7. Internal Durable IDs Follow The Same Short-ID Family

The following internal-but-durable IDs should also move off UUIDs and use the
same canonical short-ID family:

- `streamId`
- `itemId`
- `activationId`
- `deliveryId`
- `streamEventId`
- `consumerId`
- `commitId`

They do not need readable names, but they should still follow the same prefix +
short-token rule as other durable IDs.

This keeps the system from mixing:

- readable names
- short IDs
- UUIDs
- special ref-only wrappers

for durable records.

## Operational Consequences

Once implemented:

- docs and examples should stop showing `prefix_uuid` forms
- fresh v1 databases should never create UUID-backed durable IDs
- `entryId` and `threadId` should look the same in storage and in API output
- the codebase should have one canonical answer for “how do I create a new
  durable ID?”

## Open Coding Rule

After this RFC:

- new durable records must use either:
  - readable agent IDs, or
  - canonical short prefixed string IDs
- numeric fields should be used only for ordering/revision semantics, not as
  hidden durable identities that are reformatted later
