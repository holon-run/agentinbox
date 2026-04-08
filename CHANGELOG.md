# Changelog

All notable changes to `AgentInbox` should be recorded in this file.

The format is intentionally simple during public beta:

- keep one `Unreleased` section at the top
- add a versioned section before cutting a release tag
- summarize user-visible changes, notable fixes, and upgrade notes

## [Unreleased]

- No unreleased changes yet.

## [0.1.0] - 2026-04-08

### Added

- Shared-source inbox routing for local agents with durable inbox read/watch/ack.
- Terminal activation targets for `tmux` and iTerm2.
- Source adapters for `github_repo`, `github_repo_ci`, `feishu_bot`, `local_event`, and `fixture`.
- Structured subscription filters with `metadata`, `payload`, and `expr`.

### Changed

- Added caller-supplied `agentId` registration with explicit rebind behavior.
- Clarified source naming by exposing `local_event` and reserving `remote_source`.

### Notes

- `AgentInbox` remains public beta software and the CLI/source model is still evolving.
