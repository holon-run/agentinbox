# Source Types

`AgentInbox` currently supports a mix of local and provider-specific source
adapters.

## `local_event`

`local_event` is the local event ingress source.

Use it when a local producer wants to append events directly into `AgentInbox`
without building a provider-specific adapter first.

## `remote_source`

`remote_source` is a reserved product-facing name for future declarative
external sources.

It exists to distinguish future external source definitions from:

- local event ingress
- built-in provider-specific sources

The name is intentional: it describes source semantics without exposing
implementation details such as `uxc`.

## `github_repo`

`github_repo` watches GitHub repository activity and is best suited for:

- issues
- issue comments
- pull requests
- review comments
- collaboration activity

## `github_repo_ci`

`github_repo_ci` polls GitHub Actions workflow runs and is best suited for CI
state transitions.

Useful normalized metadata includes:

- `status`
- `conclusion`
- `name`
- `headBranch`
- `headSha`
- `actor`

Typical subscription filters:

```json
{"status":"completed"}
```

```json
{"status":"completed","conclusion":"failure"}
```

## `feishu_bot`

`feishu_bot` uses `uxc` long-connection subscriptions for inbound messages and
`uxc` OpenAPI delivery for replies.
