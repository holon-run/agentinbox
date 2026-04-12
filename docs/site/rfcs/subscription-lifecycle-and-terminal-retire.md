---
title: Subscription Lifecycle And Terminal Auto-Retire
date: 2026-04-13
type: page
summary: Add explicit temporary subscription lifecycle, source-scoped tracked resources, TTL cleanup, and terminal-state auto-retire for task-scoped subscriptions.
---

# Subscription Lifecycle And Terminal Auto-Retire

## Summary

`AgentInbox` should treat many task-scoped subscriptions as leased resources,
not permanent configuration.

This RFC proposes:

- make temporary subscriptions a real product path
- add explicit tracked resource binding for task-scoped subscriptions
- allow source implementations to project terminal lifecycle signals
- automatically retire temporary subscriptions when the tracked resource reaches
  a terminal state
- keep TTL/expiry cleanup as a fallback when lifecycle signals are absent or
  missed

The immediate motivation is PR-scoped or branch-scoped subscriptions that are
not cleaned up after the task completes, leading to stale inbox traffic and
growing background state.

## Problem

Today `Subscription` already contains:

- `lifecycleMode`
- `expiresAt`

But the current runtime does not close the loop well enough:

- temporary subscriptions are not a first-class, discoverable workflow
- expired subscription cleanup is not a complete operator-facing story
- task-scoped subscriptions such as PR review subscriptions are easy to forget
- agents must currently remember to remove them manually

In practice this creates:

- stale inbox noise
- unnecessary subscription polling
- more retained data than needed
- operator cleanup debt

## Goals

- make task-scoped subscriptions explicitly temporary
- make automatic cleanup possible without provider-specific core logic
- avoid parsing free-form filters to infer lifecycle binding
- let source implementations describe terminal resource states
- keep cleanup generic across GitHub and future sources

## Non-Goals

- do not turn `AgentInbox` into a workflow engine
- do not require core to understand provider-specific resource semantics
- do not require every subscription to track a resource
- do not remove manual subscription management

## Core Design

## 1. Temporary Subscriptions Should Be Normal

Task-scoped subscriptions should commonly be created as:

- `lifecycleMode = temporary`
- optional `expiresAt`

Examples:

- follow one pull request while it is active
- follow one CI failure until it is resolved
- follow one message thread during active triage

Standing subscriptions remain appropriate for long-lived repo-level or
channel-level agent interests.

## 2. Tracked Resource Binding Must Be Explicit

Automatic retire should not depend on parsing `filter`.

The lifecycle binding should be stored explicitly on the subscription.

Suggested minimal shape:

```json
{
  "trackedResourceRef": "pr:373"
}
```

This ref is scoped to the source instance.

Core matching would therefore use:

- `sourceId`
- `trackedResourceRef`

### Why Not Global Provider Objects

The core does not need a universal object such as:

- provider
- repo
- kind
- number

Those details belong to the source implementation.

The only thing core needs is a stable source-scoped opaque ref that identifies
the tracked resource for that source.

## 3. Cleanup Policy Should Be Explicit

Tracked resource binding alone is not enough.

The subscription should also say what to do when that resource reaches a
terminal state.

Suggested shape:

```json
{
  "cleanupPolicy": {
    "whenTerminal": true,
    "gracePeriodSecs": 86400
  }
}
```

This allows:

- immediate retire on terminal state
- delayed retire after a grace period
- no terminal cleanup for subscriptions that only use TTL

## 4. Source Implementations Project Lifecycle Signals

Core should not know what “merged”, “closed”, “archived”, or “resolved” means
for each provider.

Instead, source implementations should project generic lifecycle signals.

Suggested shape:

```json
{
  "ref": "pr:373",
  "terminal": true,
  "state": "closed",
  "result": "merged",
  "occurredAt": "2026-04-13T10:00:00Z"
}
```

This signal may be produced by:

- a remote profile hook
- a builtin native adapter hook in future

The core should only interpret:

- which source produced the signal
- which tracked resource ref it applies to
- whether it is terminal
- when cleanup should run

## 5. TTL Remains The Fallback Safety Net

Lifecycle signals are useful but not sufficient on their own.

Reasons:

- a provider event might not be subscribed
- a poll may miss a state transition
- a source may not implement lifecycle projection yet

Therefore:

- temporary subscriptions should still support `expiresAt`
- expired temporary subscriptions should be cleaned by GC regardless of
  lifecycle signal support

This makes cleanup robust instead of event-perfect.

## Example: GitHub Pull Request

For a GitHub PR-scoped subscription:

- `trackedResourceRef = "pr:373"`
- cleanup policy may request retire on terminal

The GitHub source implementation would project:

- `ref = "pr:373"`
- `terminal = true`
- `state = "closed"`
- `result = "merged"` when the PR is merged

Core does not need to know GitHub semantics.
It only consumes a terminal signal for `sourceId + pr:373`.

## Subscription Shortcuts

Subscription shortcuts are a good place to make temporary task-scoped
subscriptions ergonomic.

But shortcut expansion must still compile to standard fields such as:

- `filter`
- `trackedResourceRef`
- `lifecycleMode`
- `expiresAt`
- `cleanupPolicy`

This keeps shortcut use compatible with:

- CLI
- HTTP API
- skills
- operator introspection

## Runtime Behavior

## Registration

When a temporary subscription is added:

- it may include `trackedResourceRef`
- it may include `cleanupPolicy`
- it may include `expiresAt`

If `trackedResourceRef` is omitted:

- the subscription can still be temporary
- only TTL-based cleanup applies

## Event Processing

When a source event is read:

1. append the normalized inbox event as usual
2. if the source implementation projects a lifecycle signal:
   - find temporary subscriptions on the same `sourceId`
   - match `trackedResourceRef`
   - if terminal cleanup is enabled, schedule or perform retire

This should not interfere with ordinary inbox delivery.

## GC

Background lifecycle GC should perform at least two cleanup passes:

1. expired temporary subscriptions
2. subscriptions already marked for delayed terminal cleanup whose grace window
   has elapsed

## Removal Semantics

Auto-retire should remove or deactivate the subscription itself.

It should not remove the shared source.

This is important because:

- sources are shared
- subscriptions are task-scoped
- cleanup debt mostly lives at the subscription layer

## CLI And API Direction

The lifecycle fields should be visible in normal subscription inspection.

Suggested add/update inputs:

- `lifecycleMode`
- `expiresAt`
- `trackedResourceRef`
- `cleanupPolicy`

CLI may later add convenience flags, but the canonical model should remain
structured and transport-neutral.

## Why Explicit `trackedResourceRef`

The alternative is to infer lifecycle binding from `filter`.

That is fragile because filters may:

- be broad
- combine multiple resources
- use expressions not safely invertible
- mention provider-native fields in non-obvious ways

Lifecycle binding is not the same thing as event matching.

So the system should store it explicitly.

## Migration Direction

Suggested incremental rollout:

1. honor `temporary + expiresAt` in background GC
2. add `trackedResourceRef` and `cleanupPolicy` to the subscription model
3. expose lifecycle capability in resolved source schema
4. let source implementations project lifecycle signals
5. add source-specific shortcut expansion that fills lifecycle fields

This delivers value early without requiring a full end-to-end redesign first.

## Open Questions

- should auto-retire delete subscriptions immediately or first mark them
  retired for operator visibility
- should delayed cleanup state live on the subscription row or in a separate
  lifecycle queue
- should lifecycle projection be modeled as a dedicated hook return value or as
  normalized event metadata consumed by a generic lifecycle pass

