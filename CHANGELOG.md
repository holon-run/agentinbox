# Changelog

All notable changes to `AgentInbox` should be recorded in this file.

The format is intentionally simple during public beta:

- keep one `Unreleased` section at the top
- add a versioned section before cutting a release tag
- summarize user-visible changes, notable fixes, and upgrade notes

## [Unreleased]

- No unreleased changes yet.

## [1.0.0-beta.1] - 2026-04-19

### Added

- Added GitHub PR shortcut expansion support for `--withCi`, so one shortcut can
  create both the repo subscription and its sibling CI subscription with shared
  tracked-resource lifecycle semantics.

### Changed

- Tightened `/subscriptions` list responses to return the explicit envelope shape
  used by the v1 control plane, and moved tracked-resource retirement fanout
  lookup behind store-side queries and indexes instead of full subscription
  scans.

### Fixed

- Accepted `--json` as a no-op compatibility flag for default JSON-returning CLI
  commands, reducing friction for existing agent/tool integrations.
- Seeded deterministic terminal context in the CLI JSON compatibility test so
  GitHub Actions no longer fails that case when no ambient terminal session can
  be detected.

## [1.0.0-beta.0] - 2026-04-18

### Added

- Added a release smoke script that validates fresh installs, pre-v1 database
  archiving, and canonical v1 CLI/HTTP surfaces against the packaged npm
  tarball before publish.

### Changed

- Reset local storage to a single v1 baseline schema and archive any pre-v1
  database before starting fresh.
- Switched public agent-facing identifiers to canonical short durable IDs,
  including inbox entry/thread references stored in their canonical string
  form.
- Finalized the canonical host + stream source model and removed the remaining
  v1 compatibility shims for legacy source registration, inbox paging/raw-item
  reads, and deprecated remote module aliases.
- Tightened `renderAgentPrompt` to accept only canonical total-unacked input on
  the public terminal prompt boundary.

### Fixed

- Suppressed repeated terminal reinjection when the effective unacked reminder
  state has not changed after a successful dispatch.

### Upgrade Notes

- `v1.0.0-beta.0` is a fresh local-storage boundary.
- Pre-v1 databases are archived locally and replaced with a fresh v1 database.
- Archived databases are not imported into the new v1 state.

## [0.7.0] - 2026-04-17

### Added

- Added configurable daemon log levels plus structured activation-gate tracing so terminal delivery decisions can be debugged directly from daemon logs.

### Fixed

- Hardened the iTerm2 Python cursor probe so its tail normalization and busy semantics align with the existing CLI-based terminal probe path.
- Restored remote runtime compatibility during the RemoteSourceModule naming transition before the final v1 cleanup removed the deprecated alias.

### Changed

- Renamed remote source profile-facing APIs and docs to `RemoteSourceModule` terminology while keeping compatibility shims for existing callers.

## [0.6.0] - 2026-04-16

### Added

- Added source-specific activation previews so remote implementations can render better single-item terminal previews without bypassing core preview guardrails.
- Added iTerm2 Python API cursor-aware terminal activity detection to improve input-aware terminal gating when Python probe support is available.

### Fixed

- Improved terminal activity gating heuristics so cursor-aware typing checks and longer buffer-change sampling reduce notification interruptions while a terminal is actively being used.
- Fixed inbox `ack --through` ordering so reads, watches, and through-acks use the same durable sequence even when multiple inbox items share the same timestamp.

## [0.5.0] - 2026-04-16

### Added

- Added inline single-item terminal previews so agents can often understand a lone preview-friendly inbox item without an extra `inbox read` round-trip.

### Fixed

- Fixed repeated terminal reminder spam by suppressing re-prompts when the effective unacked inbox state has not changed.
- Updated Drizzle development dependencies to clear the current audit warning set without changing the published runtime dependency surface.
- Upgraded GitHub workflow actions to Node 24-compatible runtimes to remove the Node 20 action-runtime deprecation path from CI and release automation.

## [0.4.0] - 2026-04-15

### Added

- Added iTerm2 runtime-gate session parsing that matches real `it2api list-sessions` output, preventing false terminal-gone conclusions for live iTerm2 targets.
- Added hardened Codex terminal gating with session-state-backed liveness checks, recent-activity-aware deferral, and stronger visible-input detection for `codex + iTerm2`.
- Added daemon status runtime metadata so operators can see the daemon version and runtime details instead of inferring them from the CLI process alone.
- Added explicit agent and target resume commands for recovering terminal targets that were marked offline.

### Changed

- Terminal activation prompts now report current unacked inbox totals instead of historical batch-local new-item counts.
- Runtime-gate docs and operator guidance now recommend `inbox ack --through` as the default safe inbox-ack workflow.
- README and bundled AgentInbox skill now document `inbox send`, timer commands, and subscription shortcuts more explicitly.

## [0.3.0] - 2026-04-15

### Added

- Added direct inbox text ingress so local runtimes can append plain text messages without introducing a custom source adapter.
- Added durable agent reminder timers with one-shot, interval, and cron schedules.
- Added pre-dispatch terminal activity gating so AgentInbox can avoid interrupting active Codex and Claude Code sessions.
- Added Claude Code session liveness and busy-state probes for iTerm2-backed terminal targets.
- Added tmux input-aware terminal gating so terminal activation defers when a pane is actively being used.

### Fixed

- Fixed tmux terminal prompt submission to send a literal carriage return after literal text input, preserving the intended activation payload.

### Changed

- Terminal activation dispatch now treats runtime and terminal probes as first-class delivery gates instead of relying only on post-failure offline reconciliation.

## [0.2.0] - 2026-04-14

### Added

- Added cleanup-policy-driven subscription lifecycle management, including tracked resource refs, terminal retirement, and GitHub PR lifecycle projection.
- Added generic subscription shortcuts plus stream schema preview for implementation-backed sources.
- Added explicit `source remove --with-subscriptions` cleanup and idle source auto-pause after the last subscription is removed.

### Changed

- Expanded source schema resolution so instance details expose resolved source identity and implementation-backed capabilities.

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
