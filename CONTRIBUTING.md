# Contributing

## Development

Install dependencies and build the CLI:

```bash
npm install
npm run build
```

Run the test suite:

```bash
npm test
```

Build the docs site indexes and bundle:

```bash
npm run docs:index
npm run docs:build
```

## Pull Requests

- keep changes scoped to one issue or behavior change
- add or update tests for behavioral changes
- update docs when CLI, source, or workflow behavior changes
- prefer keeping migrations and compatibility decisions explicit in the PR description

## Review Workflow

`AgentInbox` uses a standing review workflow in dogfooding:

- PR opened -> review
- follow-up comments and CI are tracked through `AgentInbox`
- merge happens only after blockers are resolved and CI is green

## Releases

Release operations and manual smoke checks live in:

- [testcases/manual/release-checklist.md](./testcases/manual/release-checklist.md)
- [testcases/manual/manual-terminal-qa.md](./testcases/manual/manual-terminal-qa.md)
