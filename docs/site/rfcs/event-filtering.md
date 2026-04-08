# RFC: Agent-First Event Filtering

## Summary

`AgentInbox` should move from today's flat `matchRules` map to an
agent-first filtering model with:

- explicit `metadata` and `payload` namespaces
- a stable source schema surface for normalized fields
- an optional JS-like filter expression evaluated in a sandbox
- a small helper-function set inspired by GitHub Actions expressions and
  workflow filters

The goal is not human-friendly syntax.
The goal is to let agents write correct filters without memorizing a project-
specific DSL.

## Problem

Current `Subscription.matchRules` is too weak and too ambiguous.

Today it has these limitations:

- it flattens normalized `metadata` and source-native `payload` into one map
- it only supports simple equality, array membership, and `contains:`
- it does not support `and` / `or` / `not`
- it does not support nested payload access
- it does not expose a clear schema contract for agents

This creates two problems:

1. agents cannot easily express common filtering needs such as:
   - only completed workflow runs
   - completed failures only
   - filter out self-authored GitHub comments
   - match nested payload paths such as `payload.sender.login`
2. agents cannot easily tell whether a field is:
   - a stable `AgentInbox` normalized field
   - or a source-native payload field

## Goals

- make event filtering explicit about `metadata` vs `payload`
- let agents use a familiar JS-like boolean expression syntax
- keep normalized metadata as the stable filtering contract
- still allow source-native filtering for GitHub and other familiar sources
- provide a small built-in helper set that covers common filtering cases
- make future `source schema` introspection straightforward

## Non-Goals

- do not support arbitrary JavaScript execution
- do not expose filesystem, network, time, randomness, or process state
- do not preserve backward compatibility with the current flat `matchRules`
- do not build a general workflow engine

## Event Model

Every normalized event should continue to have:

- `eventVariant`
- `metadata`
- `payload`
- `sourceType`
- `sourceKey`

Filtering should treat these as separate namespaces.

### `metadata`

`metadata` is the stable, normalized, source-type-specific contract.

Examples for `github_repo_ci`:

- `metadata.status`
- `metadata.conclusion`
- `metadata.name`
- `metadata.headBranch`
- `metadata.actor`

Rules:

- `metadata` fields are what `AgentInbox` documents via `source schema`
- `metadata` should be the recommended default filtering surface
- source adapters should favor adding stable, high-value fields here

### `payload`

`payload` is the source-native event body.

Examples:

- `payload.event`
- `payload.sender.login`
- `payload.head_commit.message`

Rules:

- `payload` is allowed in filters
- `payload` is not promised to be cross-source stable
- `payload` is useful when the agent already understands the provider's event
  shape, such as GitHub

## Proposed Subscription Filter Shape

Replace the current flat `matchRules` map with:

```json
{
  "metadata": {
    "status": "completed",
    "conclusion": "failure"
  },
  "payload": {
    "event": "pull_request"
  },
  "expr": "metadata.status == 'completed' && metadata.conclusion == 'failure'"
}
```

Interpretation:

- `metadata` and `payload` blocks are simple exact-match shortcuts
- `expr` is optional and evaluated after the shortcut blocks match
- if `expr` is absent, only the shortcut blocks are used

This keeps the simple path simple while giving agents an escape hatch for more
complex logic.

## Expression Language

Use a JS-like boolean expression syntax implemented via `JEXL`.

Why `JEXL`:

- agents are already good at writing JS-like boolean expressions
- dotted path access is natural
- it is more natural for agents than a JSON DSL such as JsonLogic
- it can be sandboxed more safely than arbitrary JS

### Expression Context

The filter expression should only receive these variables:

- `metadata`
- `payload`
- `eventVariant`
- `sourceType`
- `sourceKey`

Example:

```js
metadata.status == "completed" &&
metadata.conclusion == "failure" &&
payload.sender.login != "jolestar"
```

### Allowed Operators

Allow the normal boolean and comparison operators supported by JEXL:

- `==`
- `!=`
- `>`
- `>=`
- `<`
- `<=`
- `&&`
- `||`
- `!`

Also allow dotted path access such as:

- `metadata.status`
- `payload.sender.login`
- `payload.head_commit.message`

## Helper Functions

The helper-function set should be intentionally small.

The baseline should be inspired by GitHub Actions expression helpers and GitHub
workflow filter patterns.

### Functions To Support

- `contains(search, item)`
- `startsWith(searchString, searchValue)`
- `endsWith(searchString, searchValue)`
- `format(template, ...)`
- `join(array, separator)`
- `matches(value, pattern)`
- `glob(value, pattern)`
- `exists(value)`

### Rationale

GitHub Actions already established a familiar mental model for:

- `contains`
- `startsWith`
- `endsWith`
- `format`
- `join`

`AgentInbox` should follow that familiarity where possible.

Two additions are worth making:

- `matches`
  - regex-based matching for advanced filtering
- `glob`
  - branch/path-like matching inspired by GitHub workflow filters

`exists` is useful for sparse source-native payloads.

### Example Filters

Only completed GitHub CI failures:

```js
metadata.status == "completed" &&
metadata.conclusion == "failure"
```

Filter out self-authored GitHub comments:

```js
payload.sender.login != "jolestar"
```

Only CI workflows on release branches:

```js
metadata.status == "completed" &&
glob(metadata.headBranch, "release/*")
```

Match workflow names using a GitHub-style helper:

```js
contains(["CI", "Copilot Code Review"], metadata.name) &&
metadata.status == "completed"
```

Match nested payload content:

```js
contains(payload.head_commit.message, "[notify-agent]")
```

## Evaluation Rules

Filter evaluation should run in this order:

1. exact match against `metadata` block, if present
2. exact match against `payload` block, if present
3. evaluate `expr`, if present

All present parts must pass for the event to match.

This keeps the common case cheap and deterministic.

## Source Schema

This RFC assumes a future `source schema` command such as:

```bash
agentinbox source schema github_repo_ci
```

Expected output should be split explicitly:

- `metadataFields`
- `payloadExamples`
- `eventVariantExamples`
- `configFields`

This is important because the filter model only stays clear if agents can ask:

- what stable metadata fields exist?
- what does the source-native payload look like?

## Security And Runtime Constraints

The expression engine must remain sandboxed.

Rules:

- no arbitrary JS `eval`
- no process access
- no filesystem access
- no network access
- no clocks or random helpers
- bounded execution time
- bounded memory use

The context should be pure event data and helper functions only.

## Migration

Compatibility is not a goal for this RFC.

Migration plan:

1. replace flat `matchRules` with a structured filter object
2. implement namespaced shortcut blocks:
   - `metadata`
   - `payload`
3. add `expr` powered by `JEXL`
4. add `source schema`
5. update source adapters to make `metadata` contracts explicit

## Open Questions

- should `expr` be named `expr`, `filter`, or `when`?
- should `metadata` and `payload` shortcut blocks support nested operator
  objects such as `{"status": {"in": ["queued", "in_progress"]}}`, or should
  advanced logic live entirely in `expr`?
- should helper functions be global or namespaced?
- should `glob` follow GitHub's exact wildcard semantics, or a smaller subset?

## Recommendation

Adopt the following as the next filtering model:

- explicit `metadata` and `payload` filter namespaces
- `JEXL` as the expression engine
- a small helper set:
  - `contains`
  - `startsWith`
  - `endsWith`
  - `format`
  - `join`
  - `matches`
  - `glob`
  - `exists`

This gives agents a filtering language they are already good at producing,
while keeping `AgentInbox`'s normalized metadata model explicit and stable.
