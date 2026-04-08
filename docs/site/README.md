# AgentInbox Docs

`AgentInbox` is the local event subscription and delivery service for agents.

It sits between external systems and local agent runtimes. It hosts shared
sources, stores normalized source events as durable streams, routes them by
subscription into agent inboxes, and activates runtimes through terminal or
webhook targets.

## Start Here

- [Getting Started](./guides/getting-started.md)
- [CLI Reference](./reference/cli.md)
- [Source Types](./reference/source-types.md)

## Concepts

- [Architecture Baseline](./concepts/architecture.md)
- [Event Bus Backend](./concepts/eventbus-backend.md)

## RFCs

- [Event Filtering RFC](./rfcs/event-filtering.md)

## Current Status

`AgentInbox` is public beta software.

- local daemon, agent registration, inbox read/watch/ack, and activation
  targets are implemented
- GitHub repo, GitHub repo CI, Feishu bot, and local event ingress source
  adapters are implemented
- CLI and source model are still evolving, especially around filtering,
  onboarding, and naming

## Recommended Runtime Modes

- `tmux`
  - most reliable terminal activation path, including auto-enter behavior
- `iTerm2`
  - supported and dogfooded, but should still be treated as a macOS-specific
    path

<!-- INDEX:START -->

- [Concepts](./concepts/)
  <!-- mdorigin:index kind=directory -->

- [Guides](./guides/)
  <!-- mdorigin:index kind=directory -->

- [Reference](./reference/)
  <!-- mdorigin:index kind=directory -->

- [RFCs](./rfcs/)
  <!-- mdorigin:index kind=directory -->

<!-- INDEX:END -->
