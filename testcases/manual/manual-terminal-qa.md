# Manual Terminal QA

This guide captures a repeatable manual smoke test for real terminal injection on
macOS with `tmux`, iTerm2, and the local `agentinbox` daemon.

It is meant for release QA, not unit testing.

## Scope

This flow verifies:

- terminal context detection for a real `tmux` pane or real iTerm2 session
- `agent register` creating a terminal activation target for that backend
- `local_event` routing into the agent inbox
- terminal prompt injection when new inbox items arrive
- repeated notification behavior before ack
- ack stopping further notification retries

This flow does not prove runtime-specific behavior inside the Codex or Claude
apps themselves. It verifies the `AgentInbox` side of terminal wake-up.

## Prerequisites

- macOS
- `tmux`
- iTerm2
- Node 20+
- repo dependencies installed
- commands available:

```bash
tmux -V
osascript -e 'return "ok"'
node -r ts-node/register src/cli.ts --version
```

## Temporary QA Home

Use an isolated home so the smoke test does not interfere with the default
daemon state:

```bash
export QA_HOME="$(mktemp -d /tmp/agentinbox-manual-qa.XXXXXX)"
export REPO="/absolute/path/to/agentinbox"
export NODE_BIN="$(command -v node)"
```

## Runtime Identity Toggle

To simulate the runtime identity used by `agent register`, set one of:

```bash
export RUNTIME_ENV='CODEX_THREAD_ID=manual-codex-qa'
```

or:

```bash
export RUNTIME_ENV='CLAUDE_CODE_SESSION_ID=manual-claude-qa'
```

The terminal injection path is the same either way. The env var only controls
runtime detection and derived `agentId`.

## tmux Smoke

Create a detached pane that registers itself, then waits on `cat` so injected
text is captured to a file:

```bash
tmux new-session -d -P -F '#{pane_id}' -s agentinbox_manual_tmux \
  "cd $REPO && AGENTINBOX_HOME=$QA_HOME $RUNTIME_ENV $NODE_BIN -r ts-node/register src/cli.ts agent register > $QA_HOME/tmux-register.json && exec cat > $QA_HOME/tmux-capture.txt"
```

Read the registered agent id:

```bash
cat "$QA_HOME/tmux-register.json"
```

Create a local source and subscription:

```bash
AGENTINBOX_HOME="$QA_HOME" "$NODE_BIN" -r ts-node/register src/cli.ts source add local_event manual-tmux --config-json '{}'
AGENTINBOX_HOME="$QA_HOME" "$NODE_BIN" -r ts-node/register src/cli.ts subscription add <agentId> <sourceId> --start-policy earliest
```

Append one event:

```bash
AGENTINBOX_HOME="$QA_HOME" "$NODE_BIN" -r ts-node/register src/cli.ts source event <sourceId> --native-id evt-tmux-1 --event local.demo --payload-json '{"message":"hello tmux"}'
```

Expected result:

- `tmux-capture.txt` contains a line like:

```text
AgentInbox: 1 new items arrived in inbox ...
```

- `tmux capture-pane -pt <paneId>` shows the same prompt

Cleanup:

```bash
AGENTINBOX_HOME="$QA_HOME" "$NODE_BIN" -r ts-node/register src/cli.ts inbox ack <agentId> --all
tmux kill-session -t agentinbox_manual_tmux
```

## iTerm2 Smoke

Open a dedicated iTerm2 window that registers itself and then waits on `cat`:

```bash
osascript -e 'tell application "iTerm2" to create window with default profile command "zsh -lc \"cd '"$REPO"' && AGENTINBOX_HOME='"$QA_HOME"' '"$RUNTIME_ENV"' '"$NODE_BIN"' -r ts-node/register src/cli.ts agent register > '"$QA_HOME"'/iterm-register.json && exec cat > '"$QA_HOME"'/iterm-capture.txt\""'
```

Read the registered agent id:

```bash
cat "$QA_HOME/iterm-register.json"
```

Create a local source and subscription:

```bash
AGENTINBOX_HOME="$QA_HOME" "$NODE_BIN" -r ts-node/register src/cli.ts source add local_event manual-iterm --config-json '{}'
AGENTINBOX_HOME="$QA_HOME" "$NODE_BIN" -r ts-node/register src/cli.ts subscription add <agentId> <sourceId> --start-policy earliest
```

Append one event:

```bash
AGENTINBOX_HOME="$QA_HOME" "$NODE_BIN" -r ts-node/register src/cli.ts source event <sourceId> --native-id evt-iterm-1 --event local.demo --payload-json '{"message":"hello iterm"}'
```

Expected result:

- `iterm-capture.txt` contains an `AgentInbox:` prompt
- if the inbox item is left unacked, iTerm2 may receive repeated prompts due to
  retry / ack-gated notification behavior

Cleanup:

```bash
AGENTINBOX_HOME="$QA_HOME" "$NODE_BIN" -r ts-node/register src/cli.ts inbox ack <agentId> --all
```

Then close the dedicated iTerm2 window manually, or via AppleScript if you
captured the window id.

## Release QA Matrix

Run the same backend smoke with both runtime identities:

- `tmux + Codex`
- `tmux + Claude Code`
- `iTerm2 + Codex`
- `iTerm2 + Claude Code`

Use:

- `CODEX_THREAD_ID=...` for Codex
- `CLAUDE_CODE_SESSION_ID=...` for Claude Code

## Observed On This Machine

Validated on this machine:

- real `tmux` pane registration and prompt injection worked
- real iTerm2 session registration and prompt injection worked
- iTerm2 repeated prompts before ack, which confirms ack-gated retry behavior
