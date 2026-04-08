# Source Types

`AgentInbox` currently supports a mix of local and provider-specific source
adapters.

## `custom`

`custom` is the local event ingress source.

Use it when a local producer wants to append events directly into `AgentInbox`
without building a provider-specific adapter first.

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
