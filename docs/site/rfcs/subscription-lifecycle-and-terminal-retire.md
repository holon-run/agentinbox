---
title: Subscription Lifecycle And Terminal Auto-Retire
date: 2026-04-13
type: page
summary: Replace temporary-subscription semantics with explicit cleanup policies, source-scoped tracked resources, deadline cleanup, and terminal-state auto-retire for task-scoped subscriptions.
---

# Subscription Lifecycle And Terminal Auto-Retire

## Summary

`AgentInbox` should treat many task-scoped subscriptions as leased resources,
not permanent configuration.

This RFC proposes:

- make task-scoped cleanup an explicit policy instead of a temporary mode
- add explicit tracked resource binding for task-scoped subscriptions
- allow source implementations to project terminal lifecycle signals
- automatically retire subscriptions when the tracked resource reaches a
  terminal state, when a configured deadline is reached, or whichever happens
  first
- keep deadline cleanup as a fallback when lifecycle signals are absent or
  missed

The immediate motivation is PR-scoped or branch-scoped subscriptions that are
not cleaned up after the task completes, leading to stale inbox traffic and
growing background state.

## Problem

Today `Subscription` already contains:

- `lifecycleMode`
- `expiresAt`

But the current runtime does not close the loop well enough:

- cleanup intent is split across ad hoc fields instead of one clear policy
- expired subscription cleanup is not a complete operator-facing story
- task-scoped subscriptions such as PR review subscriptions are easy to forget
- agents must currently remember to remove them manually

In practice this creates:

- stale inbox noise
- unnecessary subscription polling
- more retained data than needed
- operator cleanup debt

## Goals

- make task-scoped cleanup explicit without relying on a temporary/persistent split
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

## 1. Cleanup Policy Should Be Explicit

Task-scoped subscriptions should not rely on a special `temporary` category.

Instead, they should carry an explicit cleanup policy.

Suggested shape:

```json
{
  "cleanupPolicy": {
    "mode": "on_terminal_or_at",
    "at": "2026-04-20T00:00:00Z",
    "gracePeriodSecs": 86400
  }
}
```

Suggested modes:

- `manual`
- `at`
- `on_terminal`
- `on_terminal_or_at`

Examples:

- follow one pull request while it is active
- follow one CI failure until it is resolved
- follow one message thread during active triage

This makes cleanup semantics explicit:

- never auto-clean up
- clean up at a deadline
- clean up on terminal state
- clean up on terminal state or deadline, whichever happens first

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

## 3. Grace Period Is A Modifier On Terminal Cleanup

`gracePeriodSecs` is not a separate policy mode.

It only modifies terminal-based cleanup:

- `mode = on_terminal`
- `mode = on_terminal_or_at`

Its meaning is:

- resource reached terminal state
- do not retire immediately
- retire after `terminalAt + gracePeriodSecs`

This is useful when a resource often emits trailing events after the main
terminal transition.

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

- a remote module hook
- a builtin native adapter hook in future

The core should only interpret:

- which source produced the signal
- which tracked resource ref it applies to
- whether it is terminal
- when cleanup should run

## 5. Deadline Cleanup Remains The Fallback Safety Net

Lifecycle signals are useful but not sufficient on their own.

Reasons:

- a provider event might not be subscribed
- a poll may miss a state transition
- a source may not implement lifecycle projection yet

Therefore:

- cleanup policies should still support deadline-based cleanup through
  `mode = at` or `mode = on_terminal_or_at`
- expired deadline-based subscriptions should be cleaned by GC regardless of
  lifecycle signal support

This makes cleanup robust instead of event-perfect.

## Example: GitHub Pull Request

For a GitHub PR-scoped subscription:

- `trackedResourceRef = "pr:373"`
- cleanup policy may request retire on terminal, optionally with a deadline

Example:

```json
{
  "trackedResourceRef": "pr:373",
  "cleanupPolicy": {
    "mode": "on_terminal_or_at",
    "at": "2026-04-20T00:00:00Z",
    "gracePeriodSecs": 86400
  }
}
```

The GitHub source implementation would project:

- `ref = "pr:373"`
- `terminal = true`
- `state = "closed"`
- `result = "merged"` when the PR is merged

Core does not need to know GitHub semantics.
It only consumes a terminal signal for `sourceId + pr:373`.

## Subscription Shortcuts

Subscription shortcuts are a good place to make task-scoped
subscriptions ergonomic.

But shortcut expansion must still compile to standard fields such as:

- `filter`
- `trackedResourceRef`
- `cleanupPolicy`

This keeps shortcut use compatible with:

- CLI
- HTTP API
- skills
- operator introspection

## Runtime Behavior

## Registration

When a subscription with cleanup policy is added:

- it may include `trackedResourceRef`
- it may include `cleanupPolicy`

If `trackedResourceRef` is omitted:

- the subscription can still use deadline-based cleanup
- only deadline cleanup applies

## Event Processing

When a source event is read:

1. append the normalized inbox event as usual
2. if the source implementation projects a lifecycle signal:
   - find subscriptions on the same `sourceId`
   - match `trackedResourceRef`
   - if terminal cleanup is enabled by `cleanupPolicy.mode`, schedule or perform
     retire

This should not interfere with ordinary inbox delivery.

## GC

Background lifecycle GC should perform at least two cleanup passes:

1. expired deadline-based subscriptions
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

1. add `trackedResourceRef` and `cleanupPolicy` to the subscription model
2. honor deadline-based cleanup in background GC
3. expose lifecycle capability in resolved source schema
4. let source implementations project lifecycle signals
5. add source-specific shortcut expansion that fills cleanup policy fields

This delivers value early without requiring a full end-to-end redesign first.

## Open Questions

- should auto-retire delete subscriptions immediately or first mark them
  retired for operator visibility
- should delayed cleanup state live on the subscription row or in a separate
  lifecycle queue
- should lifecycle projection be modeled as a dedicated hook return value or as
  normalized event metadata consumed by a generic lifecycle pass
