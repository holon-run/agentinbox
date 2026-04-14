# Source Types

`AgentInbox` currently supports a mix of local and provider-specific source
adapters.

## `local_event`

`local_event` is the local event ingress source.

Use it when a local producer wants to append events directly into `AgentInbox`
without building a provider-specific adapter first.

## `remote_source`

`remote_source` is the generic external-source runtime surface.

It uses a local profile module to define:

- managed source spec (`source.ensure`)
- raw event mapping (`stream.read` payload -> AgentInbox event)
- config validation

It may also optionally define capability introspection hooks used by resolved
instance schema discovery:

- `describeCapabilities`
- `listSubscriptionShortcuts`
- `expandSubscriptionShortcut`
- `deriveTrackedResource`
- `projectLifecycleSignal`

Configuration fields:

- `profilePath` (required): path under `$AGENTINBOX_HOME/source-profiles`
- `profileConfig` (optional): profile-specific config object

## `github_repo`

`github_repo` watches GitHub repository activity and is best suited for:

- issues
- issue comments
- pull requests
- review comments
- collaboration activity

Builtin `github_repo` also exposes pull-request lifecycle hooks for the generic
cleanup-policy pipeline:

- `deriveTrackedResource` can derive `pr:<number>` from pull-request filters
- `projectLifecycleSignal` treats `PullRequestEvent.closed` and
  `PullRequestEvent.merged` as terminal PR lifecycle signals
- merged PRs project `result = "merged"`; plain closes project
  `result = "closed"`

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
