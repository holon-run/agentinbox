# AgentInbox

`AgentInbox` is the shared ingress and delivery layer for local agents.

It is responsible for bringing external message streams and event streams into
the local agent environment, activating target agents when relevant signals
arrive, and delivering agent replies or updates back to external systems.

`AgentInbox` is not an agent runtime. It is the layer between outside systems
and local runtimes such as `Louke`.

## One Sentence

`AgentInbox` is the shared subscription and delivery layer for local agents.

## Product Position

`AgentInbox` sits between:

- external systems such as GitHub, IM, MCP endpoints, workspace watchers, and
  web/app bridges
- local agent runtimes such as `Louke`

It should let multiple agents reuse the same local subscription sources without
forcing each agent runtime to embed provider-specific connectors.

## What It Owns

`AgentInbox` should own:

- subscription source hosting
- source-specific polling / push adapters
- shared local event intake
- agent-specific subscriptions on top of shared sources
- activation signals for target agents
- inbox-style read access to normalized items
- outbound delivery back to external systems

## What It Does Not Own

`AgentInbox` should not own:

- agent lifecycle
- long-lived runtime semantics
- queue / wake / sleep policy inside the runtime
- task orchestration
- prompt / reasoning logic
- end-user product shell
- a heavy workflow engine

## Core Boundary

Use this boundary consistently:

- `AgentInbox` owns sources and delivery
- `Louke` owns runtime meaning

That means:

- `AgentInbox` decides how outside systems are watched and how messages are
  routed or delivered
- `Louke` decides how inbound items become queue work, wakeups, task updates,
  or follow-up reasoning

## Current Mental Model

Recommended layers:

- `Commitment`
  - long-term agent responsibility, owned by the runtime and project docs
- `SubscriptionSource`
  - a shared source hosted by `AgentInbox`
- `StreamEvent`
  - one normalized source event written into the source stream
- `Subscription`
  - an agent-specific filter and consumer on top of a source
- `Inbox`
  - the delivery target for one or more subscriptions
- `InboxItem`
  - a normalized inbound item materialized into an inbox after subscription matching
- `Activation`
  - a lightweight wake signal sent to an agent runtime

Inside `AgentInbox`, the primary model should stay:

- source first
- subscription second

That allows one source to serve many agents with different filters and delivery
rules.

## Inbound / Outbound

`AgentInbox` is not receive-only.

It should support both:

- inbound: collect events and messages, then activate agents
- outbound: send replies, questions, progress updates, and notifications back
  to the correct external surface

The runtime should decide what to say.
`AgentInbox` should decide how and where it gets delivered.

## Relationship To Other Projects

- `Louke`
  - headless long-lived runtime for agents
- `uxc`
  - capability access layer
- `webmcp-bridge`
  - web/browser bridge layer
- `holon`
  - the future default assembled product and operator environment

## Execution Strategy

`AgentInbox` and `Louke` should develop in parallel.

They should share one forcing function:

- a real workflow where external systems activate a local agent
- the agent reads pending inbox items
- the agent continues work across time
- the agent sends updates or questions back through the same ingress/delivery
  layer

## Initial Direction

The current likely first workflow is:

- GitHub as a task/object surface
- IM as a driving and collaboration surface
- local workspace / project docs as ongoing context

But `AgentInbox` should stay source-agnostic enough that this is a first path,
not a permanent limitation.

## Language Choice

The first version should be built in `TypeScript / Node.js`.

Reasoning:

- this layer is connector-heavy
- SDK and CLI integrations are easier to move quickly in TypeScript
- web/app and IM integrations are usually better supported there
- `Louke` can remain the Rust runtime core

If the product later needs stronger daemon constraints or deeper local systems
integration, selective lower-level components can move later.

## Near-Term Goal

The near-term goal is not to become a large connector platform.

The near-term goal is to prove a clean local ingress/delivery layer that:

- keeps connector logic out of `Louke`
- supports shared sources for multiple agents
- activates local agents reliably
- lets those agents reply through the same system boundary

## Current Implementation

This repository now includes the first runnable `M0/M1` scaffold:

- `agentinbox serve` local daemon
- local HTTP control API for source registration, subscription polling, inbox access, delivery, and status
- thin `agentinbox` CLI for shell-first agents and operators
- SQLite-backed state for sources, streams, stream events, subscriptions, inboxes, inbox items, activations, and deliveries
- fixture source path for end-to-end local testing
- GitHub source ingestion through `uxc` poll subscriptions
- Feishu bot source ingestion through `uxc` long-connection subscriptions
- default local home at `~/.agentinbox`
- Unix socket-first local control plane with TCP fallback for explicit debug usage
- Feishu delivery through `uxc` OpenAPI calls

The current implementation proves the source-ingress / event-log / inbox-delivery
boundary with per-subscription consumer offsets.

## Commands

Install dependencies and build:

```bash
npm install
npm run build
```

Start the daemon:

```bash
node dist/src/cli.js serve
```

By default this listens on `~/.agentinbox/agentinbox.sock` and stores state in
`~/.agentinbox/agentinbox.sqlite`.

Use TCP only when you explicitly want it:

```bash
node dist/src/cli.js serve --port 4747
```

All client commands accept:

```bash
--home <path>
--socket <path>
--url <http://127.0.0.1:4747>
```

Register a shared source and subscription:

```bash
node dist/src/cli.js source add fixture demo
node dist/src/cli.js subscription add alpha <source_id> --match-json '{"channel":"engineering"}'
```

Subscriptions default to `activation_only`. For low-frequency flows, you can push the newly created inbox items directly in the activation webhook body:

```bash
node dist/src/cli.js subscription add alpha <source_id> \
  --activation-target http://127.0.0.1:8080/webhooks/agentinbox/alpha \
  --activation-mode activation_with_items
```

Register a GitHub repo source backed by `uxc` poll subscription:

```bash
node dist/src/cli.js source add github_repo holon-run/agentinbox \
  --config-json '{"owner":"holon-run","repo":"agentinbox","uxcAuth":"github-default","pollIntervalSecs":30}'
node dist/src/cli.js subscription add alpha <source_id> --match-json '{"mentions":["alpha"]}'
node dist/src/cli.js source poll <source_id>
```

Register a Feishu bot source backed by `uxc` long-connection subscription:

```bash
node dist/src/cli.js source add feishu_bot feishu-default \
  --config-json '{"uxcAuth":"feishu-default","eventTypes":["im.message.receive_v1"]}'
node dist/src/cli.js subscription add alpha <source_id> --match-json '{"mentions":["Alpha"]}'
node dist/src/cli.js source poll <source_id>
```

Emit a fixture event, materialize it into an inbox, and inspect the result:

```bash
node dist/src/cli.js fixture emit <source_id> --metadata-json '{"channel":"engineering"}' --payload-json '{"text":"hello"}'
node dist/src/cli.js subscription poll <subscription_id>
node dist/src/cli.js inbox list
node dist/src/cli.js inbox read inbox_alpha
node dist/src/cli.js inbox watch inbox_alpha
```

Record a delivery attempt:

```bash
node dist/src/cli.js deliver send --provider fixture --surface chat --target room-1 --payload-json '{"text":"reply"}'
```

Inspect status:

```bash
node dist/src/cli.js status
```

Run tests:

```bash
npm test
```
