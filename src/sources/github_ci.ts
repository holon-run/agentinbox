import { UxcDaemonClient } from "@holon-run/uxc-daemon-client";
import {
  ActivationItem,
  AppendSourceEventInput,
  DigestFlushDecision,
  DigestThreadFlushContext,
  NotificationGrouping,
  SourcePollResult,
  SourceStream,
} from "../model";
import { AgentInboxStore } from "../store";

export const GITHUB_CI_ENDPOINT = "https://api.github.com";
export const DEFAULT_GITHUB_CI_POLL_INTERVAL_SECS = 30;
export const DEFAULT_GITHUB_CI_PER_PAGE = 20;
export const DEFAULT_GITHUB_CI_DIGEST_QUIET_WINDOW_SECS = 120;
export const DEFAULT_GITHUB_CI_DIGEST_FLUSH_TIMEOUT_SECS = 60 * 60;
const GITHUB_CI_DIGEST_RECHECK_MS = 30_000;
const GITHUB_CI_DIGEST_MIN_RECHECK_MS = 1_000;
const MAX_PAGES_PER_SYNC = 10;
const MAX_SEEN_KEYS = 512;
const MAX_ERROR_BACKOFF_MULTIPLIER = 8;

export interface GithubCiSourceConfig {
  owner: string;
  repo: string;
  uxcAuth?: string;
  pollIntervalSecs?: number;
  perPage?: number;
  eventFilter?: string;
  branch?: string;
  statusFilter?: string;
  digestQuietWindowSecs?: number;
  digestFlushTimeoutSecs?: number;
  /** Explicit workflow scope for the completion barrier (not jobs or checks). */
  expectedWorkflowIds?: number[];
}

interface GithubCiSourceCheckpoint {
  lastSeenUpdatedAt?: string;
  seenRunKeys?: string[];
  lastEventAt?: string;
  lastError?: string;
}

interface WorkflowRunListResponse {
  workflow_runs?: unknown[];
}

interface GithubActionsLikeClient {
  call(args: {
    endpoint: string;
    operation: string;
    payload?: Record<string, unknown>;
    options?: { auth?: string };
  }): Promise<{ data: unknown }>;
}

export class GithubActionsUxcClient {
  constructor(private readonly client: GithubActionsLikeClient = new UxcDaemonClient({ env: process.env })) {}

  async listWorkflowRuns(config: GithubCiSourceConfig, page = 1): Promise<Record<string, unknown>[]> {
    const payload: Record<string, unknown> = {
      owner: config.owner,
      repo: config.repo,
      per_page: config.perPage ?? DEFAULT_GITHUB_CI_PER_PAGE,
      page,
    };
    if (config.eventFilter) {
      payload.event = config.eventFilter;
    }
    if (config.branch) {
      payload.branch = config.branch;
    }
    if (config.statusFilter) {
      payload.status = config.statusFilter;
    }
    const response = await this.client.call({
      endpoint: GITHUB_CI_ENDPOINT,
      operation: "get:/repos/{owner}/{repo}/actions/runs",
      payload,
      options: { auth: config.uxcAuth },
    });
    const data = asRecord(response.data) as WorkflowRunListResponse;
    return Array.isArray(data.workflow_runs)
      ? data.workflow_runs.map((value) => asRecord(value)).filter((value) => Object.keys(value).length > 0)
      : [];
  }
}

export class GithubCiSourceRuntime {
  private readonly client: GithubActionsUxcClient;
  private interval: NodeJS.Timeout | null = null;
  private readonly inFlight = new Set<string>();
  private readonly lastPollAt = new Map<string, number>();
  private readonly errorCounts = new Map<string, number>();
  private readonly nextRetryAt = new Map<string, number>();

  constructor(
    private readonly store: AgentInboxStore,
    private readonly appendSourceEvent: (input: AppendSourceEventInput) => Promise<{ appended: number; deduped: number }>,
    client?: GithubActionsUxcClient,
  ) {
    this.client = client ?? new GithubActionsUxcClient();
  }

  async ensureSource(source: SourceStream): Promise<void> {
    if (source.sourceType !== "github_repo_ci") {
      return;
    }
    const checkpoint = parseGithubCiCheckpoint(source.checkpoint);
    this.store.updateSourceRuntime(source.sourceId, {
      status: "active",
      checkpoint: JSON.stringify(checkpoint),
    });
  }

  async start(): Promise<void> {
    if (this.interval) {
      return;
    }
    this.interval = setInterval(() => {
      void this.syncAll();
    }, 2_000);
    try {
      await this.syncAll();
    } catch (error) {
      console.warn("github_repo_ci initial sync failed:", error);
    }
  }

  async stop(): Promise<void> {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  async pollSource(sourceId: string): Promise<SourcePollResult> {
    return this.syncSource(sourceId, true);
  }

  status(): Record<string, unknown> {
    return {
      activeSourceIds: Array.from(this.inFlight.values()).sort(),
      erroredSourceIds: Array.from(this.errorCounts.keys()).sort(),
    };
  }

  private async syncAll(): Promise<void> {
    const sources = this.store
      .listSources()
      .filter((source) => source.sourceType === "github_repo_ci" && source.status !== "paused");
    for (const source of sources) {
      try {
        await this.syncSource(source.sourceId, false);
      } catch (error) {
        console.warn(`github_repo_ci sync failed for ${source.sourceId}:`, error);
      }
    }
  }

  private async syncSource(sourceId: string, force: boolean): Promise<SourcePollResult> {
    if (this.inFlight.has(sourceId)) {
      return {
        sourceId,
        sourceType: "github_repo_ci",
        appended: 0,
        deduped: 0,
        eventsRead: 0,
        note: "source sync already in flight",
      };
    }
    this.inFlight.add(sourceId);
    try {
      const source = this.store.getSource(sourceId);
      if (!source) {
        throw new Error(`unknown source: ${sourceId}`);
      }
      const config = parseGithubCiSourceConfig(source);
      if (!force) {
        const retryAt = this.nextRetryAt.get(sourceId) ?? 0;
        if (Date.now() < retryAt) {
          return {
            sourceId,
            sourceType: "github_repo_ci",
            appended: 0,
            deduped: 0,
            eventsRead: 0,
            note: "error backoff not elapsed",
          };
        }
        const lastPollAt = this.lastPollAt.get(sourceId) ?? 0;
        const pollIntervalMs = (config.pollIntervalSecs ?? DEFAULT_GITHUB_CI_POLL_INTERVAL_SECS) * 1000;
        if (Date.now() - lastPollAt < pollIntervalMs) {
          return {
            sourceId,
            sourceType: "github_repo_ci",
            appended: 0,
            deduped: 0,
            eventsRead: 0,
            note: "poll interval not elapsed",
          };
        }
      }
      this.lastPollAt.set(sourceId, Date.now());
      const checkpoint = parseGithubCiCheckpoint(source.checkpoint);
      let appended = 0;
      let deduped = 0;
      let eventsRead = 0;
      let pageCount = 0;
      const checkpointLastSeenUpdatedAt = checkpoint.lastSeenUpdatedAt ?? undefined;
      let lastSeenUpdatedAt: string | undefined = checkpointLastSeenUpdatedAt;
      const seenKeys = new Set<string>(checkpoint.seenRunKeys ?? []);

      const perPage = config.perPage ?? DEFAULT_GITHUB_CI_PER_PAGE;
      for (let page = 1; page <= MAX_PAGES_PER_SYNC; page += 1) {
        const runs = await this.client.listWorkflowRuns(config, page);
        pageCount = page;
        eventsRead += runs.length;
        let pageHasNewRuns = false;

        for (const run of runs.slice().reverse()) {
          const normalized = normalizeGithubWorkflowRunEvent(source, config, run);
          if (!normalized) {
            continue;
          }
          const eventUpdatedAt = normalized.metadata?.updatedAt;
          const runKey = `${normalized.sourceNativeId}:${normalized.eventVariant}`;
          const isNewerThanCheckpoint =
            typeof eventUpdatedAt === "string" &&
            (!checkpointLastSeenUpdatedAt || eventUpdatedAt > checkpointLastSeenUpdatedAt);
          const isAtCheckpointBoundary =
            typeof eventUpdatedAt === "string" &&
            typeof checkpointLastSeenUpdatedAt === "string" &&
            eventUpdatedAt === checkpointLastSeenUpdatedAt;
          const shouldProcess =
            !checkpointLastSeenUpdatedAt ||
            isNewerThanCheckpoint ||
            (isAtCheckpointBoundary && !seenKeys.has(runKey));
          if (!shouldProcess) {
            continue;
          }
          pageHasNewRuns = true;
          const result = await this.appendSourceEvent(normalized);
          appended += result.appended;
          deduped += result.deduped;
          seenKeys.add(runKey);
          if (typeof eventUpdatedAt === "string" && (!lastSeenUpdatedAt || eventUpdatedAt >= lastSeenUpdatedAt)) {
            lastSeenUpdatedAt = eventUpdatedAt;
          }
        }

        if (!pageHasNewRuns || runs.length < perPage) {
          break;
        }
      }

      this.store.updateSourceRuntime(sourceId, {
        status: "active",
        checkpoint: JSON.stringify({
          lastSeenUpdatedAt,
          seenRunKeys: Array.from(seenKeys).slice(-MAX_SEEN_KEYS),
          lastEventAt: new Date().toISOString(),
          lastError: undefined,
        } satisfies GithubCiSourceCheckpoint),
      });
      this.errorCounts.delete(sourceId);
      this.nextRetryAt.delete(sourceId);

      return {
        sourceId,
        sourceType: "github_repo_ci",
        appended,
        deduped,
        eventsRead,
        note: `workflow runs fetched=${eventsRead} pages=${pageCount}`,
      };
    } catch (error) {
      const source = this.store.getSource(sourceId);
      if (source) {
        const checkpoint = parseGithubCiCheckpoint(source.checkpoint);
        const config = parseGithubCiSourceConfig(source);
        const nextErrorCount = (this.errorCounts.get(sourceId) ?? 0) + 1;
        this.errorCounts.set(sourceId, nextErrorCount);
        this.nextRetryAt.set(
          sourceId,
          Date.now() + computeErrorBackoffMs(config.pollIntervalSecs ?? DEFAULT_GITHUB_CI_POLL_INTERVAL_SECS, nextErrorCount),
        );
        this.store.updateSourceRuntime(sourceId, {
          status: "error",
          checkpoint: JSON.stringify({
            ...checkpoint,
            lastError: error instanceof Error ? error.message : String(error),
          }),
        });
      }
      throw error;
    } finally {
      this.inFlight.delete(sourceId);
    }
  }
}

function computeErrorBackoffMs(pollIntervalSecs: number, errorCount: number): number {
  const baseMs = Math.max(1, pollIntervalSecs) * 1000;
  const multiplier = Math.min(2 ** Math.max(0, errorCount - 1), MAX_ERROR_BACKOFF_MULTIPLIER);
  return baseMs * multiplier;
}

export function normalizeGithubWorkflowRunEvent(
  source: SourceStream,
  config: GithubCiSourceConfig,
  raw: unknown,
): AppendSourceEventInput | null {
  const run = asRecord(raw);
  const runId = asNumber(run.id);
  if (!runId) {
    return null;
  }
  const workflowName = asString(run.name) ?? asString(run.display_title);
  const conclusion = asString(run.conclusion);
  const status = inferWorkflowRunStatus(run, conclusion);
  const variant = buildWorkflowRunVariant(workflowName, status, conclusion, asNumber(run.run_attempt));
  const actor = asRecord(run.actor);
  const headCommit = asRecord(run.head_commit);
  const headRepository = asRecord(run.head_repository);
  const pullRequestNumbers = extractPullRequestNumbers(run.pull_requests);

  return {
    sourceId: source.sourceId,
    sourceNativeId: `workflow_run:${runId}`,
    eventVariant: variant,
    occurredAt: asString(run.updated_at) ?? asString(run.created_at) ?? new Date().toISOString(),
    metadata: {
      provider: "github",
      owner: config.owner,
      repo: config.repo,
      repoFullName: `${config.owner}/${config.repo}`,
      workflowRunId: runId,
      workflowId: asNumber(run.workflow_id),
      name: workflowName,
      displayTitle: asString(run.display_title),
      status,
      conclusion,
      event: asString(run.event),
      headSha: asString(run.head_sha),
      headBranch: asString(run.head_branch),
      headRepositoryFullName: asString(headRepository.full_name),
      pullRequestNumbers,
      runNumber: asNumber(run.run_number),
      runAttempt: asNumber(run.run_attempt),
      actor: asString(actor.login),
      htmlUrl: asString(run.html_url),
      runCreatedAt: asString(run.created_at),
      createdAt: asString(run.created_at),
      updatedAt: asString(run.updated_at),
      commitMessage: asString(headCommit.message),
    },
    rawPayload: {
      id: runId,
      workflow_id: asNumber(run.workflow_id),
      name: workflowName,
      display_title: asString(run.display_title),
      status,
      conclusion,
      event: asString(run.event),
      head_sha: asString(run.head_sha),
      head_branch: asString(run.head_branch),
      head_repository: {
        full_name: asString(headRepository.full_name),
      },
      pull_requests: pullRequestNumbers.map((number) => ({ number })),
      run_number: asNumber(run.run_number),
      run_attempt: asNumber(run.run_attempt),
      created_at: asString(run.created_at),
      updated_at: asString(run.updated_at),
      html_url: asString(run.html_url),
      actor: asString(actor.login),
      head_commit: {
        id: asString(headCommit.id),
        message: asString(headCommit.message),
      },
    },
    deliveryHandle: null,
  };
}

export function parseGithubCiSourceConfig(source: SourceStream): GithubCiSourceConfig {
  const config = source.config ?? {};
  const expectedWorkflowIds = parseExpectedWorkflowIds(config.expectedWorkflowIds);
  const owner = asString(config.owner);
  const repo = asString(config.repo);
  if (!owner || !repo) {
    const [fallbackOwner, fallbackRepo] = source.sourceKey.split("/", 2);
    if (!fallbackOwner || !fallbackRepo) {
      throw new Error(`github_repo_ci source requires config.owner and config.repo: ${source.sourceId}`);
    }
    return {
      owner: fallbackOwner,
      repo: fallbackRepo,
      uxcAuth: asString(config.uxcAuth) ?? asString(config.credentialRef) ?? undefined,
      pollIntervalSecs: asNumber(config.pollIntervalSecs) ?? DEFAULT_GITHUB_CI_POLL_INTERVAL_SECS,
      perPage: asNumber(config.perPage) ?? DEFAULT_GITHUB_CI_PER_PAGE,
      eventFilter: asString(config.eventFilter) ?? undefined,
      branch: asString(config.branch) ?? undefined,
      statusFilter: asString(config.statusFilter) ?? undefined,
      digestQuietWindowSecs: asNumber(config.digestQuietWindowSecs) ?? undefined,
      digestFlushTimeoutSecs: asNumber(config.digestFlushTimeoutSecs) ?? undefined,
      expectedWorkflowIds,
    };
  }
  return {
    owner,
    repo,
    uxcAuth: asString(config.uxcAuth) ?? asString(config.credentialRef) ?? undefined,
    pollIntervalSecs: asNumber(config.pollIntervalSecs) ?? DEFAULT_GITHUB_CI_POLL_INTERVAL_SECS,
    perPage: asNumber(config.perPage) ?? DEFAULT_GITHUB_CI_PER_PAGE,
    eventFilter: asString(config.eventFilter) ?? undefined,
    branch: asString(config.branch) ?? undefined,
    statusFilter: asString(config.statusFilter) ?? undefined,
    digestQuietWindowSecs: asNumber(config.digestQuietWindowSecs) ?? undefined,
    digestFlushTimeoutSecs: asNumber(config.digestFlushTimeoutSecs) ?? undefined,
    expectedWorkflowIds,
  };
}

function parseExpectedWorkflowIds(value: unknown): number[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.length === 0
      || value.some((id) => typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0)
      || new Set(value).size !== value.length) {
    throw new Error("github_repo_ci expectedWorkflowIds must be a non-empty array of unique positive integers");
  }
  return [...value];
}

export function githubCiDigestQuietWindowMs(config: GithubCiSourceConfig): number {
  return Math.max(0, (config.digestQuietWindowSecs ?? DEFAULT_GITHUB_CI_DIGEST_QUIET_WINDOW_SECS) * 1000);
}

export function githubCiDigestFlushTimeoutMs(config: GithubCiSourceConfig): number {
  return Math.max(0, (config.digestFlushTimeoutSecs ?? DEFAULT_GITHUB_CI_DIGEST_FLUSH_TIMEOUT_SECS) * 1000);
}

function firstPullRequestNumber(item: ActivationItem): number | null {
  const numbers = item.metadata.pullRequestNumbers;
  if (!Array.isArray(numbers)) {
    return null;
  }
  for (const number of numbers) {
    if (typeof number === "number" && Number.isInteger(number) && number > 0) {
      return number;
    }
  }
  return null;
}

/**
 * Groups workflow-run notifications at the pull-request level so a push that
 * fans out into many workflow runs produces one digest thread per PR instead
 * of one per run. Runs without a PR association fall back to per-push grouping
 * by head sha.
 */
export function deriveGithubCiNotificationGrouping(
  item: ActivationItem,
  config: GithubCiSourceConfig,
): NotificationGrouping | null {
  const workflowRunId = asNumber(item.metadata.workflowRunId);
  if (!workflowRunId) {
    return null;
  }
  const repoFullName = asString(item.metadata.repoFullName) ?? `${config.owner}/${config.repo}`;
  const headSha = asString(item.metadata.headSha);
  const prNumber = firstPullRequestNumber(item);
  const resourceRef = prNumber != null
    ? `pr:${repoFullName}#${prNumber}`
    : headSha
      ? `push:${repoFullName}:${headSha}`
      : null;
  if (!resourceRef) {
    return null;
  }
  return {
    groupable: true,
    resourceRef,
    eventFamily: "ci_updates",
    summaryHint: prNumber != null
      ? `CI updates for ${repoFullName}#${prNumber}`
      : `CI updates for ${repoFullName}@${shortSha(headSha)}`,
    // First failures are urgent, but only the stateful gate may admit them.
    flushClass: "normal",
    evaluateOnAppend: true,
    flushDelayMs: githubCiDigestQuietWindowMs(config),
  };
}

const ACTIONABLE_CI_FAILURES = new Set(["failure", "timed_out", "action_required", "startup_failure"]);

interface GithubCiRunEvidence {
  runId: number;
  workflowId: number | null;
  attempt: number;
  headSha: string;
  createdAt: string;
  updatedAt: string;
  status: string | null;
  conclusion: string | null;
  name: string | null;
  repoFullName: string | null;
  prNumber: number | null;
}

interface GithubCiNotificationState extends Record<string, unknown> {
  version: 1;
  headSha: string;
  headCreatedAt: string;
  headRunId: number;
  generation: number;
  startedAt: string;
  runs: GithubCiRunEvidence[];
  phase?: "first" | "final" | "incomplete";
  firstFingerprint?: string;
  finalFingerprint?: string;
  incompleteFingerprint?: string;
  /** Only currently selected run attempts, bounded by workflow scope. */
  notifiedFailures?: string[];
}

/**
 * Merge persisted evidence with unacked items. The caller commits the returned
 * notification state atomically with a snapshot only when flush is true.
 */
export function decideGithubCiDigestFlush(
  items: ActivationItem[],
  config: GithubCiSourceConfig,
  context: DigestThreadFlushContext,
): DigestFlushDecision {
  const state = mergeGithubCiEvidence(items, config, context);
  if (!state) {
    return { flush: false, reason: "no workflow evidence", recheckAfterMs: GITHUB_CI_DIGEST_RECHECK_MS };
  }
  const nowMs = Date.parse(context.now);
  const createdMs = Date.parse(state.startedAt);
  const timeoutMs = githubCiDigestFlushTimeoutMs(config);
  const timedOut = Number.isFinite(nowMs) && Number.isFinite(createdMs) && nowMs - createdMs >= timeoutMs;
  const missing = config.expectedWorkflowIds?.filter((id) => !state.runs.some((run) => run.workflowId === id));
  // A completed status without an outcome is not a complete result barrier.
  const pending = state.runs.filter((run) => !isTerminalRun(run) || !run.conclusion).length;
  const complete = Boolean(missing && missing.length === 0 && pending === 0);
  const failures = state.runs.filter((run) => ACTIONABLE_CI_FAILURES.has(run.conclusion ?? ""));
  const newFailure = failures.some((run) => !state.notifiedFailures?.includes(failureEvidenceKey(run)));
  const fingerprint = JSON.stringify([
    state.headSha, state.generation,
    state.runs.map((run) => [run.workflowId, run.runId, run.attempt, run.status, run.conclusion]),
  ]);
  if (newFailure && !state.firstFingerprint) {
    state.phase = "first";
    state.firstFingerprint = fingerprint;
    state.notifiedFailures = failures.map(failureEvidenceKey);
    // A first failure that already contains the complete result needs no
    // identical second notification.
    if (complete) {
      state.finalFingerprint = fingerprint;
    }
    return {
      flush: true, reason: `first actionable failure on ${shortSha(state.headSha)}`,
      notificationState: state, summary: summarizeCiEvidence(state, "first failure"),
    };
  }
  if (complete && state.finalFingerprint !== fingerprint) {
    state.phase = "final";
    state.finalFingerprint = fingerprint;
    state.notifiedFailures = failures.map(failureEvidenceKey);
    const allSuccessful = state.runs.every((run) => run.conclusion === "success");
    return {
      flush: true, reason: `all expected runs terminal on ${shortSha(state.headSha)}`,
      notificationState: state,
      summary: summarizeCiEvidence(state, allSuccessful ? "final: all expected workflows succeeded" : "final"),
    };
  }
  if (!complete && timedOut && !state.incompleteFingerprint) {
    state.phase = "incomplete";
    state.incompleteFingerprint = fingerprint;
    state.notifiedFailures = failures.map(failureEvidenceKey);
    const detail = missing ? `missing workflows: ${missing.join(", ") || "none"}` : "expected workflow set unknown";
    return {
      flush: true, reason: `hard timeout on ${shortSha(state.headSha)}`,
      notificationState: state, summary: summarizeCiEvidence(state, `incomplete: ${detail}`),
    };
  }
  const remaining = createdMs + timeoutMs - nowMs;
  return {
    flush: false,
    reason: complete ? "generation already notified"
      : `${pending} run(s) still pending on ${shortSha(state.headSha)}; ${missing ? `${missing.length} expected workflow(s) missing` : "expected workflow set unknown"}`,
    recheckAfterMs: Number.isFinite(remaining) && remaining > 0
      ? Math.min(GITHUB_CI_DIGEST_RECHECK_MS, Math.max(GITHUB_CI_DIGEST_MIN_RECHECK_MS, remaining))
      : GITHUB_CI_DIGEST_RECHECK_MS,
  };
}

export function summarizeGithubCiDigestThread(items: ActivationItem[], config?: GithubCiSourceConfig): string | null {
  const at = items[0]?.occurredAt ?? new Date().toISOString();
  const state = mergeGithubCiEvidence(items, config ?? { owner: "", repo: "" }, {
    threadCreatedAt: at, lastItemAt: at, now: at,
  });
  return state ? summarizeCiEvidence(state) : null;
}

function summarizeCiEvidence(state: GithubCiNotificationState, phase?: string): string {
  const failed: string[] = [];
  const other: string[] = [];
  let passed = 0;
  let running = 0;
  for (const run of state.runs) {
    if (run.conclusion === "success") {
      passed += 1;
    } else if (ACTIONABLE_CI_FAILURES.has(run.conclusion ?? "")) {
      failed.push(run.name ? `${run.name} (${run.conclusion})` : run.conclusion!);
    } else if (!isTerminalRun(run)) {
      running += 1;
    } else {
      other.push(run.name ? `${run.name} (${run.conclusion ?? "unknown conclusion"})` : run.conclusion ?? "unknown conclusion");
    }
  }
  const repoFullName = state.runs.find((run) => run.repoFullName)?.repoFullName;
  const prNumber = state.runs.find((run) => run.prNumber != null)?.prNumber;
  const target = repoFullName
    ? prNumber != null
      ? `${repoFullName}#${prNumber}`
      : `${repoFullName}@${shortSha(state.headSha)}`
    : "repository";
  const parts = [`${state.runs.length} workflow runs on ${shortSha(state.headSha)}`];
  if (phase) {
    parts.push(phase);
  }
  if (failed.length > 0) {
    const shown = failed.slice(0, 3).join(", ");
    parts.push(`${failed.length} failed: ${shown}${failed.length > 3 ? ", …" : ""}`);
  }
  if (passed > 0) {
    parts.push(`${passed} passed`);
  }
  if (running > 0) {
    parts.push(`${running} still running`);
  }
  if (other.length > 0) {
    parts.push(`${other.length} non-success: ${other.slice(0, 3).join(", ")}${other.length > 3 ? ", …" : ""}`);
  }
  return `CI for ${target}: ${parts.join(", ")}`;
}

function isTerminalRun(run: GithubCiRunEvidence): boolean {
  return run.status === "completed" || Boolean(run.conclusion);
}

function evidenceFromItem(item: ActivationItem): GithubCiRunEvidence | null {
  const runId = asNumber(item.metadata.workflowRunId);
  const headSha = asString(item.metadata.headSha);
  if (!runId || !headSha) {
    return null;
  }
  return {
    runId, headSha, workflowId: asNumber(item.metadata.workflowId),
    attempt: asNumber(item.metadata.runAttempt) ?? 1,
    // Run creation time is the only ordering proof between SHA generations.
    // occurredAt mirrors run updated_at, so a late completion of an old SHA
    // must never claim currency from delivery time; evidence without a
    // creation timestamp sorts oldest and conservatively loses head races.
    createdAt: asString(item.metadata.runCreatedAt) ?? asString(item.metadata.createdAt) ?? "",
    updatedAt: asString(item.metadata.updatedAt) ?? item.occurredAt,
    status: asString(item.metadata.status), conclusion: asString(item.metadata.conclusion),
    name: asString(item.metadata.name), repoFullName: asString(item.metadata.repoFullName),
    prNumber: firstPullRequestNumber(item),
  };
}

function evidenceKey(run: GithubCiRunEvidence): string {
  return run.workflowId == null ? `run:${run.runId}` : `workflow:${run.workflowId}`;
}

function failureEvidenceKey(run: GithubCiRunEvidence): string {
  return `${run.runId}:${run.attempt}`;
}

function timestamp(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function mergeGithubCiEvidence(
  items: ActivationItem[], config: GithubCiSourceConfig, context: DigestThreadFlushContext,
): GithubCiNotificationState | null {
  const persisted = asRecord(context.notificationState);
  // Clone: decisions must never mutate the caller's state before commit.
  let state: GithubCiNotificationState | null = persisted.version === 1 && typeof persisted.headSha === "string"
      && Array.isArray(persisted.runs)
    ? structuredClone(persisted) as GithubCiNotificationState : null;
  const uncommitted = !state;
  const incoming = items.map(evidenceFromItem).filter((run): run is GithubCiRunEvidence => Boolean(run))
    .sort((a, b) => timestamp(a.createdAt) - timestamp(b.createdAt)
      || a.runId - b.runId || a.attempt - b.attempt || timestamp(a.updatedAt) - timestamp(b.updatedAt));
  // Run creation timestamps identify pushes; updatedAt/occurredAt alone let
  // an old SHA's delayed completion accidentally become the current SHA.
  // Evidence with no creation timestamp cannot prove order, keeps the
  // persisted head SHA, and therefore cannot trigger a false notification.
  const newest = incoming.at(-1);
  if (newest && (!state || (newest.headSha !== state.headSha
      && (timestamp(newest.createdAt) > timestamp(state.headCreatedAt)
        || (timestamp(newest.createdAt) === timestamp(state.headCreatedAt) && newest.runId > state.headRunId))))) {
    state = {
      version: 1, headSha: newest.headSha, headCreatedAt: newest.createdAt,
      headRunId: newest.runId,
      generation: 1,
      startedAt: incoming.find((run) => run.headSha === newest.headSha
        && timestamp(run.createdAt) > 0)?.createdAt || context.threadCreatedAt,
      runs: [],
    };
  }
  if (!state) {
    return null;
  }
  const baseline = new Map(state.runs.map((run) => [evidenceKey(run), run]));
  // Before any snapshot is committed, unacked evidence is the only baseline.
  // Replay it from the first observation to recover SHA/run/attempt changes.
  if (uncommitted) {
    for (const run of incoming) {
      if (run.headSha === state.headSha && !baseline.has(evidenceKey(run))) {
        baseline.set(evidenceKey(run), run);
      }
    }
  }
  const runs = new Map(baseline);
  for (const next of incoming) {
    if (next.headSha !== state.headSha) {
      continue;
    }
    const key = evidenceKey(next);
    const previous = runs.get(key);
    if (previous) {
      if (next.runId !== previous.runId) {
        const newerRun = timestamp(next.createdAt) > timestamp(previous.createdAt)
          || (timestamp(next.createdAt) === timestamp(previous.createdAt) && next.runId > previous.runId);
        if (!newerRun) {
          continue;
        }
      } else if (next.attempt < previous.attempt
          || (next.attempt === previous.attempt && isTerminalRun(previous)
            && (previous.conclusion || !next.conclusion))) {
        continue;
      } else if (next.attempt === previous.attempt && !isTerminalRun(next)
          && timestamp(next.updatedAt) < timestamp(previous.updatedAt)) {
        continue;
      }
    }
    runs.set(key, next);
    if (timestamp(next.createdAt) > timestamp(state.headCreatedAt)
        || (timestamp(next.createdAt) === timestamp(state.headCreatedAt) && next.runId > state.headRunId)) {
      state.headCreatedAt = next.createdAt;
      state.headRunId = next.runId;
    }
  }
  const generationEvents = incoming.filter((run) => {
    const previous = baseline.get(evidenceKey(run));
    const selected = runs.get(evidenceKey(run));
    return run.headSha === state.headSha && selected?.runId === run.runId
      && selected.attempt === run.attempt && previous
      && (run.runId !== previous.runId || run.attempt > previous.attempt
        || (uncommitted && run.attempt > 1));
  });
  if (generationEvents.length > 0) {
    state.generation += 1;
    // Pending decisions do not persist state. Use the first evidence of this
    // generation, not evaluation time, or every recheck resets the timeout.
    state.startedAt = generationEvents.map((run) =>
      (uncommitted ? run.attempt > 1 : baseline.get(evidenceKey(run))?.runId === run.runId)
        ? run.updatedAt : run.createdAt)
      .sort((a, b) => timestamp(a) - timestamp(b))[0] ?? context.threadCreatedAt;
    delete state.phase;
    delete state.firstFingerprint;
    delete state.finalFingerprint;
    delete state.incompleteFingerprint;
  }
  state.runs = [...runs.values()].sort((a, b) => (a.workflowId ?? a.runId) - (b.workflowId ?? b.runId));
  state.notifiedFailures = state.notifiedFailures?.filter((key) => state!.runs.some((run) => failureEvidenceKey(run) === key));
  return state;
}

function shortSha(sha: string | null): string {
  return sha ? sha.slice(0, 7) : "unknown";
}

function parseGithubCiCheckpoint(checkpoint: string | null | undefined): GithubCiSourceCheckpoint {
  if (!checkpoint) {
    return {};
  }
  try {
    return JSON.parse(checkpoint) as GithubCiSourceCheckpoint;
  } catch {
    return {};
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function extractPullRequestNumbers(value: unknown): number[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const numbers = new Set<number>();
  for (const entry of value) {
    const number = asNumber(asRecord(entry).number);
    if (number && Number.isInteger(number) && number > 0) {
      numbers.add(number);
    }
  }
  return Array.from(numbers).sort((left, right) => left - right);
}

function inferWorkflowRunStatus(run: Record<string, unknown>, conclusion: string | null): string {
  return asString(run.status)
    ?? (conclusion ? "completed" : null)
    ?? "observed";
}

function buildWorkflowRunVariant(
  workflowName: string | null,
  status: string,
  conclusion: string | null,
  attempt: number | null,
): string {
  const parts = ["workflow_run"];
  const workflowSlug = slugifyWorkflowName(workflowName);
  if (workflowSlug) {
    parts.push(workflowSlug);
  }
  parts.push(status);
  if (conclusion) {
    parts.push(conclusion);
  }
  // Preserve existing first-attempt identities, but admit same-outcome reruns
  // through ingress deduplication while keeping repeat polls idempotent.
  if (attempt != null && attempt > 1) {
    parts.push(`attempt_${attempt}`);
  }
  return parts.join(".");
}

function slugifyWorkflowName(value: string | null): string | null {
  if (!value) {
    return null;
  }
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return slug.length > 0 ? slug : null;
}
