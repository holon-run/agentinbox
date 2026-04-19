---
title: Follow Command And Template Expansion
date: 2026-04-19
type: page
summary: Add a high-level `follow` command that expands module-defined templates into reusable host, stream, and subscription ensures without hardcoding providers into the AgentInbox core.
---

# Follow Command And Template Expansion

## Summary

`AgentInbox` should add a high-level `follow` command for the common operator
workflow:

- express what to follow
- let `AgentInbox` ensure the required host, stream, and subscription objects
- reuse existing shared runtime state when possible

This command should not replace the internal host and stream model.

Instead, it should sit above the existing model and compile a user intent into
an idempotent ensure plan.

The key architecture rule is:

- `core` owns generic ensure orchestration
- source modules own follow templates and intent expansion

That keeps the product simpler to operate without hardcoding provider-specific
flows into the core.

## Problem

The current mental model is correct but too operational for common use:

1. create or find a host
2. create or find a stream
3. add a subscription

This exposes storage and runtime structure directly to the user even when the
user intent is much simpler:

- follow this repo
- follow this PR
- follow this issue
- follow this search

That makes the CLI feel heavier than it needs to be, especially for
remote-module-backed providers where the actual provider logic should stay at
the edge.

There is also a naming problem:

- `inbox watch` already suggests a foreground, ongoing, stream-like read loop
- reusing `watch` for lifecycle setup would suggest long-lived connection
  behavior instead of declarative follow intent

So the simplification should not be a `watch` alias.

## Goals

- add one high-level command for common subscription setup
- preserve the existing host, stream, and subscription architecture
- keep shared source reuse and idempotent stream reuse
- avoid hardcoding provider-specific follow flows in the core
- let source modules advertise what follow intents they support
- keep low-level commands available for debugging and advanced operations
- avoid conflating declarative setup with foreground inbox reading

## Non-Goals

- do not remove `host add`, `source add`, or `subscription add`
- do not flatten the model into one private connector per agent
- do not turn `follow` into a long-running read loop
- do not require every provider to expose identical follow templates
- do not move provider SDK logic or runtime semantics into the core

## Terms

### Follow Intent

A user-facing declaration of what ongoing thing should be tracked.

Examples:

- GitHub repo activity for `holon-run/agentinbox`
- GitHub PR `#167` with CI
- X filtered stream for a query

### Follow Template

A provider- or module-defined template that knows how to expand a follow intent
into concrete `AgentInbox` resources.

Examples:

- `github.repo`
- `github.pr`
- `github.issue`
- `x.filtered_stream`
- `x.recent_search`

### Ensure Plan

The compiled plan returned by a module and executed by the core.

It should describe:

- which host to create or reuse
- which stream or streams to create or reuse
- which subscriptions to create or reuse

## Proposed UX

The high-level command should be:

```bash
agentinbox follow ...
```

This verb communicates:

- ongoing interest
- durable setup
- not a foreground read loop

`watch` should remain reserved for commands like:

```bash
agentinbox inbox watch
```

where the operator expects an active blocking read path.

### Example Intents

Illustrative examples:

```bash
agentinbox follow github repo holon-run/agentinbox
agentinbox follow github pr holon-run/agentinbox 167 --with-ci
agentinbox follow github issue holon-run/agentinbox 166
agentinbox follow x recent-search "from:holon_run agentinbox"
```

The exact CLI argument shape can vary by module, but the user should always be
thinking in terms of a follow intent, not in terms of hand-assembling storage
objects.

## Core Design

## 1. Keep Host, Stream, Subscription As Internal Reality

The follow command is a user-facing convenience layer, not a model rewrite.

The core operational model remains:

- host
- stream
- subscription

`follow` should compile into these existing objects.

This preserves:

- shared host reuse
- shared stream reuse
- separate checkpoints per stream
- agent-specific filters and cleanup on subscriptions

## 2. Modules Advertise Follow Templates

The core should not know that GitHub has a `pr --withCi` pattern or that X has
`recent_search` versus `filtered_stream`.

Instead, each source module should advertise follow templates as capability
metadata.

Suggested shape:

```json
{
  "templateId": "github.pr",
  "label": "GitHub pull request",
  "description": "Follow one pull request and optionally its CI.",
  "arguments": [
    { "name": "owner", "type": "string", "required": true },
    { "name": "repo", "type": "string", "required": true },
    { "name": "number", "type": "number", "required": true },
    { "name": "withCi", "type": "boolean", "required": false }
  ]
}
```

This should be surfaced through resolved schema or adjacent capability
discovery, not hardcoded in CLI help alone.

## 3. Modules Expand Intents Into Ensure Plans

The main extension point should be something conceptually like:

- `listFollowTemplates()`
- `expandFollowTemplate(input)`

The output should be an ensure plan that the core can execute generically.

Suggested plan shape:

```json
{
  "host": {
    "hostType": "github",
    "hostKey": "uxcAuth:github-default"
  },
  "streams": [
    {
      "streamKind": "repo_events",
      "streamKey": "holon-run/agentinbox"
    },
    {
      "streamKind": "ci_runs",
      "streamKey": "holon-run/agentinbox"
    }
  ],
  "subscriptions": [
    {
      "streamRef": "repo_events",
      "filter": { "metadata": { "number": 167, "isPullRequest": true } },
      "trackedResourceRef": "repo:holon-run/agentinbox:pr:167",
      "cleanupPolicy": { "mode": "on_terminal" }
    },
    {
      "streamRef": "ci_runs",
      "filter": { "metadata": { "pullRequestNumbers": [167] } },
      "trackedResourceRef": "repo:holon-run/agentinbox:pr:167",
      "cleanupPolicy": { "mode": "on_terminal" }
    }
  ]
}
```

The core should only validate and execute this plan. It should not contain
provider-specific branching for template semantics.

## 4. Ensure Must Be Idempotent

Repeated `follow` calls should prefer reuse over duplication.

That means:

- hosts should be keyed by provider and auth/runtime identity
- streams should be keyed by concrete feed identity
- subscriptions may still be agent-specific, but should dedupe when the same
  agent follows the same intent with the same filter and lifecycle policy

This is especially important after local resets or re-onboarding.

The system should continue to reuse existing shared streams when the underlying
managed source already exists.

## 5. Follow Should Return The Expanded Result

The command result should show what was reused or created.

Suggested response:

```json
{
  "templateId": "github.pr",
  "agentId": "agt_bronze-mole",
  "host": { "hostId": "hst_xxx", "created": false },
  "streams": [
    { "sourceId": "src_repo", "streamKind": "repo_events", "created": false },
    { "sourceId": "src_ci", "streamKind": "ci_runs", "created": false }
  ],
  "subscriptions": [
    { "subscriptionId": "sub_repo", "created": true },
    { "subscriptionId": "sub_ci", "created": true }
  ]
}
```

This keeps the system debuggable and makes `follow` safe for automation.

## 6. Keep Low-Level Commands

The existing low-level commands should remain first-class:

- `host add`
- `source add`
- `subscription add`
- `source schema`

They are still needed for:

- debugging
- custom filters
- advanced operator workflows
- providers that do not yet expose a template

`follow` should be the common path, not the only path.

## Relationship To Existing RFCs

This RFC depends on the direction already established by:

- source hosts versus streams
- resolved source kinds and capability discovery
- shared source reuse

`follow` is the operator-facing convenience layer on top of those model
decisions.

It does not replace them.

## Why `follow` Instead Of `watch`

`watch` is the wrong verb for this setup layer because it implies:

- a foreground loop
- a long-lived connection
- immediate streaming output

That is appropriate for `inbox watch`, but not for durable subscription setup.

`follow` better communicates:

- establish ongoing interest
- keep tracking over time
- let the system decide how hosting and polling happen underneath

Under the current command set, the preferred naming is:

- `follow`
- `track`
- `watch`

in that order.

## Migration Strategy

The rollout can be incremental:

1. keep existing low-level commands unchanged
2. add module capability discovery for follow templates
3. add `agentinbox follow` as a thin orchestration layer
4. progressively teach builtin and remote modules to expose templates

This allows the simplification to land without destabilizing the core storage
and runtime model.

## Open Questions

- whether follow templates should be discovered from the host, the stream kind,
  or a separate module capability namespace
- whether subscription dedupe should be strict equality or tracked-resource
  aware for common templates
- whether a `follow preview` mode should exist for planning and debugging

## Recommendation

Proceed with `follow` as the high-level command name.

Implement it as generic core orchestration over module-provided template
expansion, while keeping host, stream, and subscription as the real internal
model and keeping `watch` reserved for foreground inbox observation.
