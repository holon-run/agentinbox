# Changelog

All notable changes to `AgentInbox` should be recorded in this file.

The format is intentionally simple during public beta:

- keep one `Unreleased` section at the top
- add a versioned section before cutting a release tag
- summarize user-visible changes, notable fixes, and upgrade notes

## [Unreleased]

## [1.6.0] - 2026-09-05

### Changed

- Startup database handling is event-driven instead of unconditional (#237):
  regular opens verify the database with `PRAGMA quick_check` (escalating to a
  full `integrity_check` only when the quick pass fails) and no longer rewrite
  a full backup on every startup.
- A full backup is now taken automatically only before pending schema
  migrations run, named `<db>.pre-migrate-v<N>.bak` and bounded by
  `AGENTINBOX_MIGRATION_BACKUP_KEEP` (default 5; `0` keeps all) (#237).
- `AGENTINBOX_STARTUP_BACKUP` now defaults to off; setting it to `1` restores
  the legacy v1.5.2 behavior of an unconditional backup plus a full
  `integrity_check` on every open (#237).
- Status diagnostics now report `quickCheck` instead of running a full
  `integrity_check` on every `status` call (#237).

### Added

- `agentinbox backup` writes a verified `<db>.bak` snapshot on demand for
  scheduled or pre-upgrade snapshots; recovery considers manual and
  pre-migration backups, most recent first (#237).

### Fixed

- Corrected the v1.5.2 release notes claim that "an existing healthy backup
  is reused instead of being rewritten": that behavior was not implemented in
  v1.5.2 and startup backups were rewritten on every open. The event-driven
  model above replaces it (#237).

## [1.5.2] - 2026-09-05

### Fixed

- Daemon is now single-instance: `serve` takes an exclusive admission lock
  before opening the store, so a second `serve` exits cleanly instead of
  corrupting shared state, and clients no longer stack autostarted daemons
  during slow startup (#235, #236).
- Daemon cleanup is ownership-aware: the pid file, socket, and metadata are
  removed only by the instance that owns them, ending the mutual-deletion
  cycle between overlapping daemon lifetimes (#235, #236).
- Orphaned `.<db>.bak.<pid>.tmp` backups left by dead processes are swept on
  startup, retained `.bak` files are bounded, and an existing healthy backup
  is reused instead of being rewritten (#235, #236).

### Added

- `AGENTINBOX_NO_AUTOSTART=1` disables client autostart of the daemon, and
  `AGENTINBOX_START_TIMEOUT_MS` overrides the startup healthz wait (#235,
  #236).
- `status` now reports a distinct `starting` state when the daemon process is
  alive but not yet serving (#235, #236).

### Upgrade notes

- Deployments that supervise the daemon with their own service manager can set
  `AGENTINBOX_NO_AUTOSTART=1` so clients never autostart another instance.

## [1.5.1] - 2026-09-04

### Changed

- Webhook activation targets no longer re-dispatch on every flush window while
  a notify lease is active. Items arriving during the lease merge into pending
  state, and a single re-dispatch covers them on the next ack (when items no
  previous notification covered remain) or on lease expiry. Fully acked
  targets delete their dispatch state without re-dispatching (#220, #233).
- Ack-driven webhook re-dispatch now requires unnotified pending items;
  acking already-notified entries no longer produces a redundant POST.

### Upgrade notes

- Deployments that relied on per-window webhook re-dispatch during a lease can
  lower the target's `notifyLeaseMs` to shorten the worst-case wait for new
  items that arrive while a lease is active.

## [1.5.0] - 2026-07-11

### Added

- Added operator ingress reply routes for agent-initiated outbound delivery
  through delivery handles (#217).
- Compact CLI inbox output by default; added `--full` flag to show the full
  expanded view (#228).

### Fixed

- Fixed operator delivery callback contract to match the documented boundary
  (#219).
- Validated follow template args before preview source to surface user errors
  early (#223).
- Self-healed ghost subscription/source references in `syncAllSubscriptions`
  (#222, #230).
- Increased idle source auto-pause grace period to 30 minutes to avoid
  premature pausing of slow sources (#226, #229).
- Added CLI usability aliases and did-you-mean suggestions for common mistyped
  commands (#225, #232).
- Fixed spurious `wake_hint` dispatch when all inbox items were acked before
  buffer flush (#220, #231).

## [1.4.1] - 2026-06-22

### Changed

- Refactored Telegram source to use uxc polling instead of a direct
  integration (#216).

## [1.4.0] - 2026-06-21

### Added

- Added status diagnostics for daemon, database health, source/agent counts,
  activation target reachability, activation dispatch backlog, and delivery
  retry state.

### Changed

- Split store subscription query and SQLite migration/recovery coverage into
  focused tests while keeping the end-to-end smoke path in the integration
  suite.

## [1.3.3] - 2026-06-19

### Fixed

- Added `--entry-id` as an alias for `--entry` in `agentinbox ack`, matching
  entry identifier terminology used elsewhere in the CLI while preserving the
  existing `--entry` flag.

## [1.3.2] - 2026-06-12

### Fixed

- Migrated local SQLite persistence from `sql.js` whole-file exports to
  `better-sqlite3` with WAL-backed on-disk writes, avoiding non-atomic database
  rewrites that could corrupt the inbox store.
- Added startup integrity checks and recovery from backup snapshots before
  falling back to a fresh database.

## [1.3.1] - 2026-05-22

### Fixed

- Webhook dispatch now uses exponential backoff for transient errors (5s → 10s →
  20s → ... → max 5min) instead of a fixed 5-second retry loop.
- Permanently failed webhook targets (HTTP 404/409/410/422) are now cleaned up
  immediately instead of retrying indefinitely.
- `flushNotificationBuffer` now clears dispatch state for "offline" outcomes.

## [1.2.0] - 2026-05-21

### Added

- Added Feishu/Lark source operations to list message attachments and save one
  attachment to an absolute local path.
- Extracted Feishu/Lark message files, images, and cloud document links into
  message metadata so agents can discover attachments from inbox items and
  message context.
- Added local save support for Feishu/Lark doc/docx/wiki Markdown export,
  message file/image downloads, and sheet/base exports.

## [1.1.0] - 2026-05-20

### Changed

- Improved dynamic delivery command failures so unsupported surfaces and
  operations return HTTP 400 with actionable `agentinbox deliver actions`
  guidance instead of unhelpful 500 responses.
- Documented `chat_message` as the Feishu surface for sending new messages to a
  chat, while keeping unsupported names such as `group_message` rejected with a
  clear supported-surface hint.

## [1.0.5] - 2026-05-19

### Added

- Added Feishu IM source operations for recent message context lookup and chat
  discovery, including `list_recent_messages`, `list_chats`, `search_chats`,
  and `get_chat`.
- Added a Commander-backed CLI command shell so bare command groups such as
  `agentinbox agent` print group help while dynamic provider/template/action
  commands remain runtime-discovered.

## [1.0.4] - 2026-05-15

### Fixed

- Preserved `runtimeKind` during webhook registration updates so webhook-only
  Holon agents continue to be identified as Holon-backed after endpoint or
  secret changes.

## [1.0.3] - 2026-04-23

### Fixed

- Fixed `agentinbox follow ... --help` so help is handled locally and does not
  trigger follow preview or template expansion.

### Changed

- Updated and published the bundled AgentInbox skill to prefer `agentinbox
  follow`, avoid routine daemon status checks, and move status checks to
  troubleshooting guidance.

## [1.0.2] - 2026-04-22

### Fixed

- Changed user-facing terminal reminder text to prefer `agentId` over
  `inboxId` as the primary identifier in reminder messages.
- Kept `renderAgentPrompt()` backward compatible for legacy callers that still
  pass `inboxId`, while moving internal reminder generation to the new
  `agentId`-first wording.

## [1.0.1] - 2026-04-21

### Fixed

- Added webhook-only agent registration convergence in both directions so a
  later terminal `agent register` call is rejected while an active webhook
  target exists.
- Extended CLI, control-plane, and service coverage for webhook-only agent
  registration, including webhook-specific validation and regression tests for
  the `webhook -> terminal` conflict path.

## [1.0.0] - 2026-04-20

### Added

- Shipped the stable v1 `AgentInbox` storage and API boundary, including
  canonical host + stream registration, durable inbox entry/thread reads, and
  handle-scoped delivery operations for local agent integrations.
- Added first-class GitHub PR review workflow support across shared repo and CI
  sources, including PR shortcut expansion, PR-scoped lifecycle cleanup, and
  durable latest-entry notification metadata for downstream agents.

### Changed

- Graduated the `v1.0.0-beta` line to the stable `1.0.0` release without
  changing the final beta code surface beyond release metadata and docs.
- Standardized the local daemon, control plane, and public CLI on the finalized
  v1 identifier and source model.

### Fixed

- Fixed silent notification black holes for session-bound terminal agents by
  keeping offline targets detached until they are explicitly resumed or rebound.
- Hardened GitHub review and CI tracking so PR-scoped subscriptions survive
  preview truncation, missing workflow PR linkage, and older-page workflow run
  pagination boundaries more reliably.

### Upgrade Notes

- `1.0.0` keeps the same v1 local-storage boundary introduced in
  `v1.0.0-beta.0`.
- If you are upgrading from any pre-v1 build, AgentInbox archives the old local
  database and starts with a fresh v1 database under `~/.agentinbox/`.

## [1.0.0-beta.5] - 2026-04-20

### Changed

- Rolled the beta release line forward without additional code changes beyond
  `v1.0.0-beta.4`, so local environments can converge on the latest published
  beta package and release tag.

## [1.0.0-beta.4] - 2026-04-20

### Fixed

- Made GitHub `pr --withCi` follow filters more reliable by combining
  `pullRequestNumbers` matching with a deterministic head branch and repository
  fallback when workflow-run payloads omit PR linkage.
- Tightened `github_repo_ci` polling to paginate back to the checkpoint
  boundary, reducing the chance of missing PR workflow runs that land on older
  pages while still avoiding unbounded reprocessing.

## [1.0.0-beta.3] - 2026-04-19

### Fixed

- Fixed silent notification black holes for session-bound agents by keeping
  offline agents detached while terminal targets are being resumed or rebound.
- Scoped GitHub `pr --withCi` sibling `ci_runs` subscriptions to the tracked PR
  by normalizing workflow-run `pullRequestNumbers` and using that metadata in
  generated CI filters.

## [1.0.0-beta.2] - 2026-04-19

### Changed

- Clarified the bundled AgentInbox skill guidance so it explicitly distinguishes
  durable inbox and subscription state from session-bound terminal delivery, and
  documents `--force-rebind` for later-session recovery.

### Fixed

- Restored PR-scoped review notifications for `github_repo` sources when GitHub
  repo-event payload previews truncate review metadata, including pull request
  number recovery for `PullRequestReviewEvent` and
  `PullRequestReviewCommentEvent`.
- Bounded GitHub review-event hydration fallback so metadata recovery remains
  best-effort, degrades safely on fetch failure, and avoids excessive polling
  amplification on the repo-events sync path.

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
