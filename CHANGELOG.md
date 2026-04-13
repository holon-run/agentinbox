# Changelog

All notable changes to `AgentInbox` should be recorded in this file.

The format is intentionally simple during public beta:

- keep one `Unreleased` section at the top
- add a versioned section before cutting a release tag
- summarize user-visible changes, notable fixes, and upgrade notes

## [Unreleased]

- No unreleased changes yet.

## [0.1.4] - 2026-04-13

### Fixed

- Added `--test-force-exit` to the test runner so release and CI jobs no longer hang after all test cases have already passed.

## [0.1.3] - 2026-04-13

### Fixed

- Removed legacy GitHub and Feishu direct-subscription runtime code that no longer compiles against `@holon-run/uxc-daemon-client@0.15.0`.
- Kept the source modules focused on the live managed-source path by retaining only delivery helpers plus event normalization and config parsing.

## [0.1.2] - 2026-04-13

### Fixed

- `agentinbox inbox read` now rejects unsupported flags such as `--ack` instead of silently ignoring them.

### Changed

- Upgraded `@holon-run/uxc-daemon-client` to `0.15.0` and raised the documented minimum `uxc` version to `0.15.0`.
- Refreshed onboarding and release docs to match the current skill-first setup and release workflow.

## [0.1.1] - 2026-04-10

### Added

- Public maintenance docs for contributors, security reporting, and community expectations.
- Source update support for changing persisted source config and config refs in place.
- Source pause and resume commands for managed remote sources.

### Fixed

- `github_repo_ci` now preserves workflow run status transitions instead of dropping `completed.*` after an earlier `observed` event.
- Explicit subscription filter input modes now reject empty objects as well as blank input, preventing accidental broad subscriptions.
- Paused remote source updates now validate and roll back invalid config changes without resuming the source.

### Changed

- Current docs and bundled AgentInbox skill now reflect the live CLI surface and recommended onboarding flow.

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
