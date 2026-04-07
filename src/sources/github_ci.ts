import { UxcDaemonClient } from "@holon-run/uxc-daemon-client";
import { AppendSourceEventInput, SourcePollResult, SubscriptionSource } from "../model";
import { AgentInboxStore } from "../store";

const GITHUB_ENDPOINT = "https://api.github.com";
const DEFAULT_POLL_INTERVAL_SECS = 30;
const DEFAULT_PER_PAGE = 20;
const MAX_SEEN_KEYS = 512;

export interface GithubCiSourceConfig {
  owner: string;
  repo: string;
  uxcAuth?: string;
  pollIntervalSecs?: number;
  perPage?: number;
  eventFilter?: string;
  branch?: string;
  statusFilter?: string;
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

  async listWorkflowRuns(config: GithubCiSourceConfig): Promise<Record<string, unknown>[]> {
    const payload: Record<string, unknown> = {
      owner: config.owner,
      repo: config.repo,
      per_page: config.perPage ?? DEFAULT_PER_PAGE,
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
      endpoint: GITHUB_ENDPOINT,
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

  constructor(
    private readonly store: AgentInboxStore,
    private readonly appendSourceEvent: (input: AppendSourceEventInput) => Promise<{ appended: number; deduped: number }>,
    client?: GithubActionsUxcClient,
  ) {
    this.client = client ?? new GithubActionsUxcClient();
  }

  async ensureSource(source: SubscriptionSource): Promise<void> {
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
    };
  }

  private async syncAll(): Promise<void> {
    const sources = this.store.listSources().filter((source) => source.sourceType === "github_repo_ci" && source.status === "active");
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
        const lastPollAt = this.lastPollAt.get(sourceId) ?? 0;
        const pollIntervalMs = (config.pollIntervalSecs ?? DEFAULT_POLL_INTERVAL_SECS) * 1000;
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
      const runs = await this.client.listWorkflowRuns(config);
      let appended = 0;
      let deduped = 0;
      let lastSeenUpdatedAt: string | undefined = checkpoint.lastSeenUpdatedAt ?? undefined;
      const seenKeys = new Set<string>(checkpoint.seenRunKeys ?? []);

      for (const run of runs.slice().reverse()) {
        const normalized = normalizeGithubWorkflowRunEvent(source, config, run);
        if (!normalized) {
          continue;
        }
        const eventUpdatedAt = normalized.metadata?.updatedAt;
        const runKey = `${normalized.sourceNativeId}:${normalized.eventVariant}`;
        const shouldProcess =
          !lastSeenUpdatedAt ||
          (typeof eventUpdatedAt === "string" && eventUpdatedAt > lastSeenUpdatedAt) ||
          !seenKeys.has(runKey);
        if (!shouldProcess) {
          continue;
        }
        const result = await this.appendSourceEvent(normalized);
        appended += result.appended;
        deduped += result.deduped;
        seenKeys.add(runKey);
        if (typeof eventUpdatedAt === "string" && (!lastSeenUpdatedAt || eventUpdatedAt >= lastSeenUpdatedAt)) {
          lastSeenUpdatedAt = eventUpdatedAt;
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

      return {
        sourceId,
        sourceType: "github_repo_ci",
        appended,
        deduped,
        eventsRead: runs.length,
        note: `workflow runs fetched=${runs.length}`,
      };
    } catch (error) {
      const source = this.store.getSource(sourceId);
      if (source) {
        const checkpoint = parseGithubCiCheckpoint(source.checkpoint);
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

export function normalizeGithubWorkflowRunEvent(
  source: SubscriptionSource,
  config: GithubCiSourceConfig,
  raw: unknown,
): AppendSourceEventInput | null {
  const run = asRecord(raw);
  const runId = asNumber(run.id);
  if (!runId) {
    return null;
  }
  const status = asString(run.status) ?? "unknown";
  const conclusion = asString(run.conclusion);
  const variant = conclusion && status === "completed"
    ? `workflow_run.${status}.${conclusion}`
    : `workflow_run.${status}`;
  const actor = asRecord(run.actor);
  const headCommit = asRecord(run.head_commit);

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
      name: asString(run.name),
      displayTitle: asString(run.display_title),
      status,
      conclusion,
      event: asString(run.event),
      headSha: asString(run.head_sha),
      headBranch: asString(run.head_branch),
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
      name: asString(run.name),
      display_title: asString(run.display_title),
      status,
      conclusion,
      event: asString(run.event),
      head_sha: asString(run.head_sha),
      head_branch: asString(run.head_branch),
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

function parseGithubCiSourceConfig(source: SubscriptionSource): GithubCiSourceConfig {
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
      pollIntervalSecs: asNumber(config.pollIntervalSecs) ?? DEFAULT_POLL_INTERVAL_SECS,
      perPage: asNumber(config.perPage) ?? DEFAULT_PER_PAGE,
      eventFilter: asString(config.eventFilter) ?? undefined,
      branch: asString(config.branch) ?? undefined,
      statusFilter: asString(config.statusFilter) ?? undefined,
    };
  }
  return {
    owner,
    repo,
    uxcAuth: asString(config.uxcAuth) ?? asString(config.credentialRef) ?? undefined,
    pollIntervalSecs: asNumber(config.pollIntervalSecs) ?? DEFAULT_POLL_INTERVAL_SECS,
    perPage: asNumber(config.perPage) ?? DEFAULT_PER_PAGE,
    eventFilter: asString(config.eventFilter) ?? undefined,
    branch: asString(config.branch) ?? undefined,
    statusFilter: asString(config.statusFilter) ?? undefined,
  };
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
