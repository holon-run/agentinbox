# AgentInbox

`AgentInbox` is the local event subscription and delivery service for agents.

It connects external and local event sources, stores them as durable streams,
routes them by subscription, and lets agents read, watch, acknowledge, and
reply through one boundary.

`AgentInbox` is not an agent runtime. It sits between outside systems and local
agent runtimes.

In practice, that means `AgentInbox` can:

- share one GitHub or Feishu source across multiple local agents
- materialize those events into durable inboxes
- wake or drive agent sessions running in `tmux` or `iTerm2`, even when the
  agent runtime does not expose a notification API

## Status

`AgentInbox` is still early-stage infrastructure software.

- the local control plane, inbox model, and custom source flow are implemented
- GitHub repo, GitHub repo CI, and Feishu bot source adapters are implemented
- the public CLI shape is stabilizing, but source adapter behavior should still
  be treated as beta

## Install

Requires:

- Node.js 20 or newer
- a local `uxc` daemon if you want to use GitHub or Feishu adapters

Install globally:

```bash
npm install -g @holon-run/agentinbox
```

Or run directly with `npx`:

```bash
npx @holon-run/agentinbox --help
```

If you are developing from source:

```bash
npm install
npm run build
node dist/src/cli.js --help
```

## Quick Start

Run the local daemon:

```bash
agentinbox serve
```

Register the current terminal session. `AgentInbox` detects the runtime and
terminal context, assigns a stable `agentId`, and attaches a terminal
activation target to that agent:

```bash
agentinbox agent register
```

Create a custom source and subscribe the returned `agentId` to it:

```bash
agentinbox source add custom local-demo
agentinbox subscription add <agent_id> <source_id>
agentinbox source event <source_id> --native-id demo-1 --event custom.demo
```

This is the shortest end-to-end flow:

- a source event is appended
- `AgentInbox` materializes it into an inbox item
- the current terminal session receives an injected `agent_prompt`

## Runtime Paths

By default `AgentInbox` uses a local home directory at:

```text
~/.agentinbox
```

Default files:

- database: `~/.agentinbox/agentinbox.sqlite`
- socket: `~/.agentinbox/agentinbox.sock`

You can override these with:

- `AGENTINBOX_HOME`
- `AGENTINBOX_SOCKET`
- `AGENTINBOX_URL`
- `agentinbox serve --home ...`
- `agentinbox serve --socket ...`
- `agentinbox serve --port ...`

## One Sentence

`AgentInbox` is the local event subscription and delivery service for agents.

## Product Position

`AgentInbox` sits between:

- external systems such as GitHub, IM, MCP endpoints, workspace watchers, and
  web/app bridges
- local agent runtimes

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
- downstream runtimes own runtime meaning

That means:

- `AgentInbox` decides how outside systems are watched and how messages are
  routed or delivered
- downstream runtimes decide how inbound items become queue work, wakeups, task
  updates, or follow-up reasoning

## Current Mental Model

Recommended layers:

- `Commitment`
  - long-term agent responsibility, owned by the runtime and project docs
- `SubscriptionSource`
  - a shared source hosted by `AgentInbox`
- `StreamEvent`
  - one normalized source event written into the source stream
- `Agent`
  - the runtime identity and default activation target owner
- `Subscription`
  - an agent-specific filter and consumer on top of a source
- `Inbox`
  - the agent's durable internal inbox
- `InboxItem`
  - a normalized inbound item materialized into an inbox after subscription matching
- `Activation`
  - a lightweight wake signal sent to an agent runtime

Inside `AgentInbox`, the primary model is now:

- source first
- agent second
- subscription as the routing rule between them

## Inbound / Outbound

`AgentInbox` is not receive-only.

It should support both:

- inbound: collect events and messages, then activate agents
- outbound: send replies, questions, progress updates, and notifications back
  to the correct external surface

The runtime should decide what to say.
`AgentInbox` should decide how and where it gets delivered.

## Relationship To Other Projects

- `uxc`
  - capability access layer
- `webmcp-bridge`
  - web/browser bridge layer
- `holon`
  - the future default assembled product and operator environment

## Execution Strategy

`AgentInbox` should stay loosely coupled to the runtime layer.

The forcing function is still:

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
- the runtime core can evolve independently

If the product later needs stronger daemon constraints or deeper local systems
integration, selective lower-level components can move later.

## Near-Term Goal

The near-term goal is not to become a large connector platform.

The near-term goal is to prove a clean local ingress/delivery layer that:

- keeps connector logic out of agent runtimes
- supports shared sources for multiple agents
- activates local agents reliably
- lets those agents reply through the same system boundary

## Current Implementation

This repository now includes the first runnable `M0/M1` scaffold:

- `agentinbox serve` local daemon
- local HTTP control API for source registration, subscription polling, inbox access, delivery, and status
- thin `agentinbox` CLI for shell-first agents and operators
- SQLite-backed state for agents, activation targets, sources, streams, stream events, subscriptions, inbox items, activations, and deliveries
- fixture source path for end-to-end local testing
- GitHub source ingestion through `uxc` poll subscriptions
- Feishu bot source ingestion through `uxc` long-connection subscriptions
- default local home at `~/.agentinbox`
- Unix socket-first local control plane with TCP fallback for explicit debug usage
- Feishu delivery through `uxc` OpenAPI calls

The current implementation proves the source-ingress / event-log / agent-inbox
boundary with per-subscription consumer offsets and shared activation target
dispatch semantics.

## Quick Start

Start the daemon:

```bash
agentinbox serve
```

By default this listens on `~/.agentinbox/agentinbox.sock` and stores state in
`~/.agentinbox/agentinbox.sqlite`.

Use TCP only when you explicitly want it:

```bash
agentinbox serve --port 4747
```

All client commands accept:

```bash
--home <path>
--socket <path>
--url <http://127.0.0.1:4747>
```

Register the current session as an agent:

```bash
agentinbox agent register
```

Create a programmable local event bus source and publish events into it:

```bash
agentinbox source add custom project-alpha
agentinbox subscription add <agent_id> <source_id> --filter-json '{"metadata":{"channel":"engineering"}}'
agentinbox source event <source_id> \
  --native-id evt-1 \
  --event message.created \
  --metadata-json '{"channel":"engineering"}' \
  --payload-json '{"text":"hello from a local producer"}'
agentinbox subscription poll <subscription_id>
agentinbox inbox read <agent_id>
```

For a long-lived local consumer, keep a watch open:

```bash
agentinbox inbox watch <agent_id>
```

Inspect the documented metadata contract and example payloads for a source type:

```bash
agentinbox source schema github_repo_ci
```

## Source Adapters

### Custom source

`custom` sources let any local producer use `AgentInbox` as a lightweight local
event bus.

```bash
agentinbox source add custom project-alpha
agentinbox source event <source_id> --native-id evt-1 --event message.created
```

### GitHub repo

`github_repo` watches the GitHub repository activity feed and is best suited for:

- issues
- issue comments
- pull requests
- review comments
- mentions and collaboration activity

Example:

```bash
agentinbox source add github_repo holon-run/agentinbox \
  --config-json '{"owner":"holon-run","repo":"agentinbox","uxcAuth":"github-default","pollIntervalSecs":30}'
agentinbox subscription add <agent_id> <source_id> --filter-json '{"metadata":{"mentions":["alpha"]}}'
agentinbox source poll <source_id>
```

### GitHub repo CI

`github_repo_ci` polls GitHub Actions workflow runs and is best suited for CI
state transitions such as failures on a branch or workflow.

```bash
agentinbox source add github_repo_ci holon-run/agentinbox \
  --config-json '{"owner":"holon-run","repo":"agentinbox","uxcAuth":"github-default","pollIntervalSecs":30,"perPage":20}'
agentinbox subscription add <agent_id> <source_id> --filter-json '{"metadata":{"conclusion":"failure","headBranch":"main"}}'
agentinbox source poll <source_id>
```

### Feishu bot

`feishu_bot` uses `uxc` long-connection subscriptions for inbound messages and
`uxc` OpenAPI delivery for replies and sends.

Prerequisites:

- a configured Feishu credential in `uxc`
- the required bot event subscription and IM permissions enabled in Feishu

## Activations

Activation defaults now belong to the agent, not the subscription. Add a webhook
activation target to an agent:

```bash
agentinbox agent target add webhook <agent_id> \
  --url http://127.0.0.1:8080/webhooks/agentinbox/alpha \
  --activation-mode activation_with_items
```

## Agent Registration And Activation Targets

For local agent sessions that do not expose a notification API, `AgentInbox`
registers the current terminal session as an agent and injects an
`agent_prompt` back into it when new inbox items arrive.

Register the current session:

```bash
agentinbox agent register
```

The response includes an assigned `agentId` and the current terminal activation
target. Use the returned `agentId` for later subscription and inbox commands.

`AgentInbox` detects the current terminal context automatically. `tmux` targets
are injected with `send-keys ... Enter`. `iTerm2` targets are injected through
AppleScript using the current session identity. When available, runtime session
identities such as `CODEX_THREAD_ID` are recorded and used to derive a stable
assigned `agentId`.

All activation targets share the same gating behavior:

- the first batch of new inbox items triggers one injected prompt
- no further prompt is injected until the inbox is acknowledged
- if more items arrive before acknowledgement, they are coalesced
- if the session never acknowledges, the prompt is retried after the target's
  notify lease expires

## CLI

`help` and `version` are text-first:

```bash
agentinbox --help
agentinbox source --help
agentinbox help inbox
agentinbox --version
```

Resource and control-plane commands default to JSON output.

## Development

Run the test suite:

```bash
npm test
```

Build the published CLI artifact:

```bash
npm run build
```

## License

Apache-2.0

Register a Feishu bot source backed by `uxc` long-connection subscription:

```bash
node dist/src/cli.js source add feishu_bot feishu-default \
  --config-json '{"uxcAuth":"feishu-default","eventTypes":["im.message.receive_v1"]}'
node dist/src/cli.js subscription add <agent_id> <source_id> --filter-json '{"metadata":{"mentions":["Alpha"]}}'
node dist/src/cli.js source poll <source_id>
```

Emit a fixture event for tests and local demos:

```bash
node dist/src/cli.js fixture emit <source_id> --metadata-json '{"channel":"engineering"}' --payload-json '{"text":"hello"}'
node dist/src/cli.js subscription poll <subscription_id>
node dist/src/cli.js inbox show <agent_id>
node dist/src/cli.js inbox read <agent_id>
node dist/src/cli.js inbox watch <agent_id>
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
