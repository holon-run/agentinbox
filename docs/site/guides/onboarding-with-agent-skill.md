# Onboarding With The AgentInbox Skill

If you are already using Codex or Claude Code, the recommended onboarding path
is to hand the bundled `AgentInbox` skill to the agent and let it configure the
local workflow for you.

This is the preferred path for first-run setup. It avoids pushing the user
through raw `source add`, `subscription add`, and `uxc` auth commands before the
agent is ready.

If you use the community `skills` installer, install the bundled skill with:

```bash
npx skills add holon-run/agentinbox --skill agentinbox -a codex -a claude-code
```

## What The Skill Should Do

The bundled skill lives at:

- [`skills/agentinbox/SKILL.md`](../../../skills/agentinbox/SKILL.md)
- [`/skills/agentinbox/SKILL`](../skills/agentinbox/SKILL.md)

When used for onboarding, the skill should:

1. verify `agentinbox` is available in `PATH`
2. start or verify the local daemon
3. verify `uxc` is available
4. verify GitHub auth is usable
5. if `gh` is already authenticated, import that token into `uxc`
6. register the current terminal session as an agent
7. use the docs-site examples to add standing GitHub subscriptions

## Recommended Checks

The agent should verify:

```bash
agentinbox --version
agentinbox daemon status
uxc --version
gh auth status
```

If the daemon is not running:

```bash
agentinbox daemon start
```

If GitHub auth should be reused from `gh`:

```bash
uxc auth credential import github --from gh
```

This requires `uxc` 0.15.3 or newer:

- https://github.com/holon-run/uxc

## After Auth

Once `uxc` can access GitHub and the current terminal session is registered, the
agent can move directly into real usage:

- add a shared GitHub host plus `repo_events` or `ci_runs` streams
- add standing subscriptions for review comments or CI failures
- add task-specific subscriptions for a PR or branch
- remove those subscriptions when the task is done

See:

- [Getting Started](./getting-started.md)
- [Review Workflows](./review-workflows.md)
- [CLI Reference](../reference/cli.md)

## Why Skill-First

`AgentInbox` onboarding is still evolving. The skill can absorb environment
checks, `uxc` auth reuse, and per-agent workflow setup without forcing the user
to manually learn every low-level CLI step first.
