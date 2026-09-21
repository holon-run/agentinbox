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
  const variant = buildWorkflowRunVariant(workflowName, status, conclusion);
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
  };
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
  const conclusion = asString(item.metadata.conclusion);
  const actionableFailure = Boolean(conclusion) && conclusion !== "success" && conclusion !== "skipped";
  return {
    groupable: true,
    resourceRef,
    eventFamily: "ci_updates",
    summaryHint: prNumber != null
      ? `CI updates for ${repoFullName}#${prNumber}`
      : `CI updates for ${repoFullName}@${shortSha(headSha)}`,
    flushClass: actionableFailure ? "immediate" : "normal",
    flushDelayMs: githubCiDigestQuietWindowMs(config),
  };
}

/**
 * Post-hoc flush decision for a PR-level CI digest thread: flush once every
 * workflow run observed for the thread's latest head sha has reached a
 * terminal state (or the hard timeout expires). GitHub exposes no prior about
 * how many runs a push will create, so readiness is judged from the observed
 * event stream itself.
 */
export function decideGithubCiDigestFlush(
  items: ActivationItem[],
  config: GithubCiSourceConfig,
  context: DigestThreadFlushContext,
): DigestFlushDecision {
  if (items.length === 0) {
    return { flush: true, reason: "no pending items" };
  }
  const ordered = orderItemsByOccurredAt(items);
  const latestSha = latestHeadSha(ordered);
  if (!latestSha) {
    return { flush: true, reason: "no head sha" };
  }
  const nowMs = Date.parse(context.now);
  const createdMs = Date.parse(context.threadCreatedAt);
  const timeoutMs = githubCiDigestFlushTimeoutMs(config);
  const timedOut = Number.isFinite(nowMs) && Number.isFinite(createdMs) && nowMs - createdMs >= timeoutMs;
  if (!timedOut) {
    const runTerminal = new Map<number, boolean>();
    for (const item of ordered) {
      if (asString(item.metadata.headSha) !== latestSha) {
        continue;
      }
      const runId = asNumber(item.metadata.workflowRunId);
      if (!runId) {
        continue;
      }
      const status = asString(item.metadata.status);
      const conclusion = asString(item.metadata.conclusion);
      runTerminal.set(runId, status === "completed" || Boolean(conclusion));
    }
    let pending = 0;
    for (const terminal of runTerminal.values()) {
      if (!terminal) {
        pending += 1;
      }
    }
    if (pending > 0) {
      const remaining = createdMs + timeoutMs - nowMs;
      const recheckAfterMs = Number.isFinite(remaining)
        ? Math.min(GITHUB_CI_DIGEST_RECHECK_MS, Math.max(GITHUB_CI_DIGEST_MIN_RECHECK_MS, remaining))
        : GITHUB_CI_DIGEST_RECHECK_MS;
      return {
        flush: false,
        reason: `${pending} run(s) still pending on ${shortSha(latestSha)}`,
        recheckAfterMs,
      };
    }
  }
  return {
    flush: true,
    reason: timedOut ? `hard timeout on ${shortSha(latestSha)}` : `all runs terminal on ${shortSha(latestSha)}`,
  };
}

export function summarizeGithubCiDigestThread(items: ActivationItem[]): string | null {
  if (items.length === 0) {
    return null;
  }
  const ordered = orderItemsByOccurredAt(items);
  let repoFullName: string | null = null;
  let prNumber: number | null = null;
  let latestSha: string | null = null;
  for (const item of ordered) {
    repoFullName = asString(item.metadata.repoFullName) ?? repoFullName;
    prNumber = firstPullRequestNumber(item) ?? prNumber;
    latestSha = asString(item.metadata.headSha) ?? latestSha;
  }
  const runs = new Map<number, { name: string | null; conclusion: string | null }>();
  for (const item of ordered) {
    const runId = asNumber(item.metadata.workflowRunId);
    if (!runId) {
      continue;
    }
    const previous = runs.get(runId) ?? { name: null, conclusion: null };
    runs.set(runId, {
      name: asString(item.metadata.name) ?? previous.name,
      conclusion: asString(item.metadata.conclusion) ?? previous.conclusion,
    });
  }
  const failed: string[] = [];
  let passed = 0;
  let running = 0;
  for (const run of runs.values()) {
    if (run.conclusion === "success" || run.conclusion === "skipped") {
      passed += 1;
    } else if (run.conclusion) {
      failed.push(run.name ? `${run.name} (${run.conclusion})` : run.conclusion);
    } else {
      running += 1;
    }
  }
  const target = repoFullName
    ? prNumber != null
      ? `${repoFullName}#${prNumber}`
      : latestSha
        ? `${repoFullName}@${shortSha(latestSha)}`
        : repoFullName
    : "repository";
  const parts = [`${runs.size} workflow runs on ${shortSha(latestSha)}`];
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
  return `CI for ${target}: ${parts.join(", ")}`;
}

function orderItemsByOccurredAt(items: ActivationItem[]): ActivationItem[] {
  return [...items].sort((left, right) => Date.parse(left.occurredAt) - Date.parse(right.occurredAt));
}

function latestHeadSha(orderedItems: ActivationItem[]): string | null {
  let latestSha: string | null = null;
  let latestAt = Number.NaN;
  for (const item of orderedItems) {
    const sha = asString(item.metadata.headSha);
    if (!sha) {
      continue;
    }
    const at = Date.parse(item.occurredAt);
    if (latestSha == null || (!Number.isNaN(at) && (Number.isNaN(latestAt) || at >= latestAt))) {
      latestSha = sha;
      latestAt = at;
    }
  }
  return latestSha;
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
