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

`AgentInbox` is public beta software.

- the local control plane, daemon model, inbox model, and activation targets
  are implemented
- GitHub repo, GitHub repo CI, Feishu bot, and local event ingress source
  adapters are implemented
- CLI and source model are still evolving, especially around onboarding,
  filtering, and source naming

## Install

Requires:

- Node.js 20 or newer
- a local `uxc` daemon if you want to use GitHub or Feishu adapters

Install globally:

```bash
npm install -g @holon-run/agentinbox
```

Or run directly:

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

Start the local daemon:

```bash
agentinbox daemon start
```

Register the current terminal session:

```bash
agentinbox agent register
agentinbox agent register --agent-id agent-alpha
```

Create a local source and publish an event:

```bash
agentinbox source add local_event local-demo
agentinbox subscription add <agent_id> <source_id>
agentinbox source event <source_id> --native-id demo-1 --event local.demo
agentinbox inbox read <agent_id>
```

Remove a task-specific subscription without deleting the whole agent:

```bash
agentinbox subscription remove <subscription_id>
```

## Docs

Public docs now live under [`docs/site`](./docs/site) and are structured for
`mdorigin`.

- docs home: [`docs/site/README.md`](./docs/site/README.md)
- getting started: [`docs/site/guides/getting-started.md`](./docs/site/guides/getting-started.md)
- CLI reference: [`docs/site/reference/cli.md`](./docs/site/reference/cli.md)
- source types: [`docs/site/reference/source-types.md`](./docs/site/reference/source-types.md)
- architecture: [`docs/site/concepts/architecture.md`](./docs/site/concepts/architecture.md)
- event bus design: [`docs/site/concepts/eventbus-backend.md`](./docs/site/concepts/eventbus-backend.md)
- event filtering RFC: [`docs/site/rfcs/event-filtering.md`](./docs/site/rfcs/event-filtering.md)

Preview the docs site locally:

```bash
npm run docs:dev
```

## Development

Run tests:

```bash
npm test
```

Build the CLI:

```bash
npm run build
```

Build docs directory indexes:

```bash
npm run docs:index
```

## Release

`AgentInbox` releases are tag-driven.

- update [package.json](./package.json) and [CHANGELOG.md](./CHANGELOG.md) in a PR before release
- merge to `main`
- run the manual terminal smoke matrix in [testcases/manual/manual-terminal-qa.md](./testcases/manual/manual-terminal-qa.md)
- push a tag in the form `v<package.json version>`

Public beta tags such as `v0.1.0-beta.1` publish to npm with the `beta`
dist-tag. Stable tags such as `v0.1.0` publish with the `latest` dist-tag.

The operational checklist lives in
[testcases/manual/release-checklist.md](./testcases/manual/release-checklist.md).

## License

Apache-2.0
