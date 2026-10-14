# GitHub CI Notification Policy

The GitHub `ci_runs` stream (`github_repo_ci` adapter) groups GitHub Actions
workflow-run updates by pull request, or by head SHA when no PR is associated.
The digest gate evaluates every append, including the first failure; normal
digest scheduling and item thresholds do not bypass it.

## Explicit workflow scope

Configure the workflows whose outcomes matter to this source:

```bash
agentinbox source add <host_id> ci_runs holon-run/agentinbox \
  --config-json '{"owner":"holon-run","repo":"agentinbox","expectedWorkflowIds":[12345,67890],"digestFlushTimeoutSecs":3600}'
```

Replace the example IDs with the repository's GitHub Actions **workflow IDs**.
`expectedWorkflowIds` is optional. If supplied, it must be a non-empty array of
unique positive integers. This set defines the minimum completion barrier,
not an event filter: other observed workflows on the active SHA still
participate in failure alerts and summaries, and pending observed runs block
completion. This is a workflow-level contract,
not discovery of every CI provider, third-party check, individual job, matrix
job, or branch-protection requirement. The adapter does not proactively discover
the expected set through the GitHub API.

Ensure source filters and agent interests admit updates for every configured
workflow. Filtering only failures hides successful or running members of the
barrier and can result in an incomplete digest.

## Notification rules

- The first `failure`, `timed_out`, `action_required`, or `startup_failure`
  qualifies immediately, even while other workflows are running or missing.
- Later failures in the same generation wait for the explicit set to be present
  and all observed runs to be terminal with known conclusions, then produce one final summary. If the first failure already
  includes the complete result, an identical final notification is suppressed.
- A success summary requires every expected workflow to be present and every
  observed workflow to have a successful latest run attempt. Observing only
  successful runs is not enough.
- `cancelled`, `skipped`, and `neutral` are terminal but neither successful nor
  urgent. A complete terminal set containing them gets an accurate non-success
  summary, not an “all succeeded” summary.
- With no explicit set, or with missing or running members, the hard timeout
  produces an **incomplete** summary. An unknown set remains unknown even when
  every observed run succeeded.

`digestQuietWindowSecs` (default `120`) is a scheduling hint only; silence is
never evidence of a complete workflow set. `digestFlushTimeoutSecs` defaults to
`3600`. After an incomplete notification, duplicate updates do not repeat it;
a subsequently completed explicit set can still produce a final summary.

## SHA cycles, reruns, and acknowledgement

The latest observed run creation timestamp, with run ID as a tie-breaker,
identifies the active SHA cycle. A late update from an older SHA cannot replace
it merely because its update or delivery timestamp is newer. Events normalize
the run creation time as `runCreatedAt`; `occurredAt`/`updatedAt` mirror update
time and never prove which SHA is current. An event that carries no run
creation time cannot prove its order either, so it keeps the persisted head SHA
instead of switching generations or notifying. This is evidence from the
workflow stream, not an independent query for the PR's current head.

A higher attempt on the same run, or a newer replacement run of the same
workflow on the same SHA, starts a new notification generation. Other
workflows' latest results remain available for partial reruns; rerunning one
workflow does not require unrelated workflows to rerun. An unchanged failure
in another workflow is not urgently re-notified. Old attempts, older replacement
runs, duplicate deliveries, and late queued updates cannot undo an observed
terminal result. Timeout timing uses generation evidence rather than resetting
on every gate evaluation.

Normalized events keep the workflow run ID as their native identity and include
attempts greater than one as an `.attempt_<N>` suffix in the event variant. This preserves first-attempt
identities while allowing a rerun with the same status and conclusion through
ingress deduplication; repeated observations of the same attempt remain deduplicated.

The core stores opaque adapter state per inbox/group, atomically with the
notification snapshot. It includes current workflow/run IDs, attempts, creation
and update timestamps, running and terminal evidence, and first/final/incomplete
phase fingerprints. Acknowledging a snapshot, rotating its thread, or restarting
the service does not erase the notification barrier or cause repeated alerts.
