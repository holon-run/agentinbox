# Review Workflows

This guide describes a practical `AgentInbox` workflow for a review-focused
agent.

The default recommendation is:

- keep one standing agent for ongoing review work
- add a small set of standing subscriptions
- add task-specific subscriptions for a PR or branch when needed
- remove the temporary subscriptions when the task is done

## Standing Subscriptions

Typical standing subscriptions for a review agent are:

- GitHub review comments and PR discussion events
- CI completions that require action, usually failures

Keep these standing subscriptions low-noise. They should point the agent at real
work, not every observable lifecycle event.

## Task-Specific Subscriptions

For a single PR or branch, add temporary subscriptions such as:

- PR discussion events for `metadata.number == <pr_number>`
- CI completion events for `metadata.headBranch == <branch>` and `metadata.status == "completed"`

When the task is finished:

```bash
agentinbox subscription remove <subscriptionId>
```

This lets one long-lived agent follow many short-lived review tasks without
creating a new agent session for each one.

## Why Remove Matters

Temporary review subscriptions should not become standing subscriptions by
accident.

Removing them after the task is done keeps:

- the inbox quieter
- notifications more relevant
- future review prompts easier to interpret

## Filter Design

For review workflows, prefer structured metadata filters where possible:

- `metadata.number`
- `metadata.status`
- `metadata.conclusion`
- `metadata.headBranch`
- `metadata.name`

Use expression filters only when the shortcut form is not enough.

See also:

- [Getting Started](./getting-started.md)
- [CLI Reference](../reference/cli.md)
- [Event Filtering RFC](../rfcs/event-filtering.md)
