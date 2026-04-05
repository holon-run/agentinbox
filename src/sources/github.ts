import { UxcDaemonClient, type PollSubscriptionConfig, type SubscribeStartResponse, type SubscriptionEventEnvelope } from "@holon-run/uxc-daemon-client";
import {
  DeliveryAttempt,
  DeliveryHandle,
  DeliveryRequest,
  EmitItemInput,
  SourcePollResult,
  SubscriptionSource,
} from "../model";
import { AgentInboxStore } from "../store";

const GITHUB_ENDPOINT = "https://api.github.com";
const DEFAULT_EVENT_TYPES = [
  "IssuesEvent",
  "IssueCommentEvent",
  "PullRequestEvent",
  "PullRequestReviewCommentEvent",
];

export interface GithubSourceConfig {
  owner: string;
  repo: string;
  uxcAuth?: string;
  pollIntervalSecs?: number;
  perPage?: number;
  eventTypes?: string[];
}

interface GithubSourceCheckpoint {
  uxcJobId?: string;
  afterSeq?: number;
  lastEventAt?: string;
  lastError?: string;
}

export interface UxcLikeClient {
  subscribeStart(args: {
    endpoint: string;
    operationId?: string;
    args?: Record<string, unknown>;
    mode?: "stream" | "poll";
    pollConfig?: PollSubscriptionConfig;
    options?: { auth?: string };
    sink?: "memory:" | `file:${string}`;
    ephemeral?: boolean;
  }): Promise<SubscribeStartResponse>;
  subscribeStatus(jobId: string): Promise<{ status: string }>;
  subscriptionEvents(args: {
    jobId: string;
    afterSeq?: number;
    limit?: number;
    waitMs?: number;
  }): Promise<{ status: string; events: SubscriptionEventEnvelope[]; next_after_seq: number; has_more: boolean }>;
  call(args: {
    endpoint: string;
    operation: string;
    payload?: Record<string, unknown>;
    options?: { auth?: string };
  }): Promise<{ data: unknown }>;
}

export class GithubUxcClient {
  constructor(private readonly client: UxcLikeClient = new UxcDaemonClient({ env: process.env })) {}

  async ensureRepoEventsSubscription(
    config: GithubSourceConfig,
    checkpoint: GithubSourceCheckpoint,
  ): Promise<SubscribeStartResponse> {
    if (checkpoint.uxcJobId) {
      try {
        const status = await this.client.subscribeStatus(checkpoint.uxcJobId);
        if (status.status === "running" || status.status === "reconnecting") {
          return {
            job_id: checkpoint.uxcJobId,
            mode: "poll",
            protocol: "openapi",
            endpoint: GITHUB_ENDPOINT,
            sink: "memory:",
            status: status.status,
          };
        }
      } catch {
        // Recreate the job below.
      }
    }

    const started = await this.client.subscribeStart({
      endpoint: GITHUB_ENDPOINT,
      operationId: "get:/repos/{owner}/{repo}/events",
      args: { owner: config.owner, repo: config.repo, per_page: config.perPage ?? 10 },
      mode: "poll",
      pollConfig: {
        interval_secs: config.pollIntervalSecs ?? 30,
        extract_items_pointer: "",
        checkpoint_strategy: {
          type: "item_key",
          item_key_pointer: "/id",
          seen_window: 1024,
        },
      },
      options: { auth: config.uxcAuth },
      sink: "memory:",
      ephemeral: false,
    });
    return started;
  }

  async readSubscriptionEvents(jobId: string, afterSeq: number): Promise<{ events: SubscriptionEventEnvelope[]; nextAfterSeq: number; status: string }> {
    const response = await this.client.subscriptionEvents({
      jobId,
      afterSeq,
      limit: 100,
      waitMs: 10,
    });
    return {
      events: response.events,
      nextAfterSeq: response.next_after_seq,
      status: response.status,
    };
  }

  async createIssueComment(input: { owner: string; repo: string; issueNumber: number; body: string; auth?: string }): Promise<void> {
    await this.client.call({
      endpoint: GITHUB_ENDPOINT,
      operation: "post:/repos/{owner}/{repo}/issues/{issue_number}/comments",
      payload: {
        owner: input.owner,
        repo: input.repo,
        issue_number: input.issueNumber,
        body: input.body,
      },
      options: { auth: input.auth },
    });
  }

  async replyToReviewComment(input: { owner: string; repo: string; pullNumber: number; commentId: number; body: string; auth?: string }): Promise<void> {
    await this.client.call({
      endpoint: GITHUB_ENDPOINT,
      operation: "post:/repos/{owner}/{repo}/pulls/{pull_number}/comments/{comment_id}/replies",
      payload: {
        owner: input.owner,
        repo: input.repo,
        pull_number: input.pullNumber,
        comment_id: input.commentId,
        body: input.body,
      },
      options: { auth: input.auth },
    });
  }
}

export class GithubSourceRuntime {
  private readonly client: GithubUxcClient;
  private interval: NodeJS.Timeout | null = null;
  private readonly inFlight = new Set<string>();

  constructor(
    private readonly store: AgentInboxStore,
    private readonly emitItem: (input: EmitItemInput) => Promise<{ inserted: number }>,
    client?: GithubUxcClient,
  ) {
    this.client = client ?? new GithubUxcClient();
  }

  async ensureSource(source: SubscriptionSource): Promise<void> {
    if (source.sourceType !== "github_repo") {
      return;
    }
    const config = parseGithubSourceConfig(source);
    const checkpoint = parseGithubCheckpoint(source.checkpoint);
    const started = await this.client.ensureRepoEventsSubscription(config, checkpoint);
    this.store.updateSourceRuntime(source.sourceId, {
      status: "active",
      checkpoint: JSON.stringify({
        ...checkpoint,
        uxcJobId: started.job_id,
      }),
    });
  }

  async start(): Promise<void> {
    if (this.interval) {
      return;
    }
    this.interval = setInterval(() => {
      void this.syncAll();
    }, 2_000);
    await this.syncAll();
  }

  async stop(): Promise<void> {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  async pollSource(sourceId: string): Promise<SourcePollResult> {
    return this.syncSource(sourceId);
  }

  status(): Record<string, unknown> {
    return {
      activeSourceIds: Array.from(this.inFlight.values()).sort(),
    };
  }

  private async syncAll(): Promise<void> {
    const sources = this.store.listSources().filter((source) => source.sourceType === "github_repo" && source.status === "active");
    for (const source of sources) {
      await this.syncSource(source.sourceId);
    }
  }

  private async syncSource(sourceId: string): Promise<SourcePollResult> {
    if (this.inFlight.has(sourceId)) {
      return {
        sourceId,
        sourceType: "github_repo",
        inserted: 0,
        ignored: 0,
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
      if (this.store.listInterestsForSource(sourceId).length === 0) {
        return {
          sourceId,
          sourceType: "github_repo",
          inserted: 0,
          ignored: 0,
          eventsRead: 0,
          note: "no interests registered for source",
        };
      }
      const config = parseGithubSourceConfig(source);
      let checkpoint = parseGithubCheckpoint(source.checkpoint);
      const subscription = await this.client.ensureRepoEventsSubscription(config, checkpoint);
      if (subscription.job_id !== checkpoint.uxcJobId) {
        checkpoint = { ...checkpoint, uxcJobId: subscription.job_id };
      }

      const batch = await this.client.readSubscriptionEvents(checkpoint.uxcJobId!, checkpoint.afterSeq ?? 0);
      let inserted = 0;
      let ignored = 0;
      for (const event of batch.events) {
        if (event.event_kind !== "data") {
          continue;
        }
        const normalized = normalizeGithubRepoEvent(source, config, event.data);
        if (!normalized) {
          ignored += 1;
          continue;
        }
        const result = await this.emitItem(normalized);
        inserted += result.inserted;
        if (result.inserted === 0) {
          ignored += 1;
        }
      }

      this.store.updateSourceRuntime(sourceId, {
        status: "active",
        checkpoint: JSON.stringify({
          ...checkpoint,
          uxcJobId: checkpoint.uxcJobId,
          afterSeq: batch.nextAfterSeq,
          lastEventAt: new Date().toISOString(),
          lastError: null,
        }),
      });

      return {
        sourceId,
        sourceType: "github_repo",
        inserted,
        ignored,
        eventsRead: batch.events.length,
        note: `subscription status=${batch.status}`,
      };
    } catch (error) {
      const source = this.store.getSource(sourceId);
      if (source) {
        const checkpoint = parseGithubCheckpoint(source.checkpoint);
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

export class GithubDeliveryAdapter {
  private readonly client: GithubUxcClient;

  constructor(client?: GithubUxcClient) {
    this.client = client ?? new GithubUxcClient();
  }

  async send(request: DeliveryRequest, attempt: DeliveryAttempt): Promise<{ status: "sent"; note: string }> {
    const payloadText = stringifyDeliveryPayload(request.payload);
    const target = parseTargetRef(attempt.targetRef);
    if (attempt.surface === "issue_comment" || attempt.surface === "pull_request_comment") {
      await this.client.createIssueComment({
        owner: target.owner,
        repo: target.repo,
        issueNumber: target.number,
        body: payloadText,
      });
      return { status: "sent", note: "sent GitHub issue comment" };
    }
    if (attempt.surface === "review_comment") {
      if (!attempt.threadRef || !attempt.threadRef.startsWith("review_comment:")) {
        throw new Error("review_comment delivery requires threadRef=review_comment:<id>");
      }
      await this.client.replyToReviewComment({
        owner: target.owner,
        repo: target.repo,
        pullNumber: target.number,
        commentId: Number(attempt.threadRef.slice("review_comment:".length)),
        body: payloadText,
      });
      return { status: "sent", note: "sent GitHub review comment reply" };
    }
    throw new Error(`unsupported GitHub surface: ${attempt.surface}`);
  }
}

export function normalizeGithubRepoEvent(
  source: SubscriptionSource,
  config: GithubSourceConfig,
  raw: unknown,
): EmitItemInput | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const event = raw as Record<string, unknown>;
  const eventType = asString(event.type);
  if (!eventType || !(config.eventTypes ?? DEFAULT_EVENT_TYPES).includes(eventType)) {
    return null;
  }
  const eventId = asString(event.id);
  if (!eventId) {
    return null;
  }

  const actor = asRecord(event.actor);
  const payload = asRecord(event.payload);
  const repo = asRecord(event.repo);
  const issue = asRecord(payload.issue);
  const pullRequest = asRecord(payload.pull_request);
  const comment = asRecord(payload.comment);
  const action = asString(payload.action) ?? "observed";

  const number = asNumber(issue.number) ?? asNumber(pullRequest.number);
  const isPullRequest = eventType.startsWith("PullRequest");
  const title = asString(issue.title) ?? asString(pullRequest.title) ?? null;
  const body = asString(comment.body) ?? asString(issue.body) ?? asString(pullRequest.body) ?? null;
  const labels = extractLabels(issue.labels);
  const mentions = extractMentions(title, body);
  const url =
    asString(comment.html_url) ??
    asString(issue.html_url) ??
    asString(pullRequest.html_url) ??
    asString(event["url"]);
  const deliveryHandle = buildGithubDeliveryHandle(config, eventType, number, comment);

  return {
    sourceId: source.sourceId,
    sourceNativeId: `github_event:${eventId}`,
    eventVariant: `${eventType}.${action}`,
    occurredAt: asString(event.created_at) ?? new Date().toISOString(),
    metadata: {
      provider: "github",
      owner: config.owner,
      repo: config.repo,
      repoFullName: asString(repo.name) ?? `${config.owner}/${config.repo}`,
      eventType,
      action,
      number,
      author: asString(actor.login) ?? null,
      isPullRequest,
      labels,
      mentions,
      title,
      body,
      url,
    },
    rawPayload: {
      id: eventId,
      type: eventType,
      action,
      actor: actor.login ?? null,
      issue,
      pull_request: pullRequest,
      comment,
    },
    deliveryHandle,
  };
}

function buildGithubDeliveryHandle(
  config: GithubSourceConfig,
  eventType: string,
  number: number | null,
  comment: Record<string, unknown>,
): DeliveryHandle | null {
  if (!number) {
    return null;
  }
  if (eventType === "PullRequestReviewCommentEvent") {
    const commentId = asNumber(comment.id);
    return {
      provider: "github",
      surface: "review_comment",
      targetRef: `${config.owner}/${config.repo}#${number}`,
      threadRef: commentId ? `review_comment:${commentId}` : null,
      replyMode: "reply",
    };
  }
  return {
    provider: "github",
    surface: eventType === "PullRequestEvent" ? "pull_request_comment" : "issue_comment",
    targetRef: `${config.owner}/${config.repo}#${number}`,
    threadRef: null,
    replyMode: "comment",
  };
}

function parseGithubSourceConfig(source: SubscriptionSource): GithubSourceConfig {
  const config = source.config ?? {};
  const owner = asString(config.owner);
  const repo = asString(config.repo);
  if (!owner || !repo) {
    const [fallbackOwner, fallbackRepo] = source.sourceKey.split("/", 2);
    if (!fallbackOwner || !fallbackRepo) {
      throw new Error(`github_repo source requires config.owner and config.repo: ${source.sourceId}`);
    }
    return {
      owner: fallbackOwner,
      repo: fallbackRepo,
      uxcAuth: asString(config.uxcAuth) ?? asString(config.credentialRef) ?? undefined,
      pollIntervalSecs: asNumber(config.pollIntervalSecs) ?? 30,
      perPage: asNumber(config.perPage) ?? 10,
      eventTypes: asStringArray(config.eventTypes) ?? DEFAULT_EVENT_TYPES,
    };
  }
  return {
    owner,
    repo,
    uxcAuth: asString(config.uxcAuth) ?? asString(config.credentialRef) ?? undefined,
    pollIntervalSecs: asNumber(config.pollIntervalSecs) ?? 30,
    perPage: asNumber(config.perPage) ?? 10,
    eventTypes: asStringArray(config.eventTypes) ?? DEFAULT_EVENT_TYPES,
  };
}

function parseGithubCheckpoint(checkpoint: string | null | undefined): GithubSourceCheckpoint {
  if (!checkpoint) {
    return {};
  }
  try {
    return JSON.parse(checkpoint) as GithubSourceCheckpoint;
  } catch {
    return {};
  }
}

function extractLabels(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .map((value) => asRecord(value))
    .map((value) => asString(value.name))
    .filter((value): value is string => Boolean(value));
}

function extractMentions(...values: Array<string | null>): string[] {
  const seen = new Set<string>();
  for (const value of values) {
    if (!value) {
      continue;
    }
    const matches = value.match(/@([a-zA-Z0-9_-]+)/g) ?? [];
    for (const match of matches) {
      seen.add(match.slice(1));
    }
  }
  return Array.from(seen.values()).sort();
}

function parseTargetRef(targetRef: string): { owner: string; repo: string; number: number } {
  const match = targetRef.match(/^([^/]+)\/([^#]+)#(\d+)$/);
  if (!match) {
    throw new Error(`invalid GitHub targetRef: ${targetRef}`);
  }
  return {
    owner: match[1],
    repo: match[2],
    number: Number(match[3]),
  };
}

function stringifyDeliveryPayload(payload: Record<string, unknown>): string {
  if (typeof payload.text === "string") {
    return payload.text;
  }
  return JSON.stringify(payload, null, 2);
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
  return typeof value === "number" ? value : null;
}

function asStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  return value.filter((item): item is string => typeof item === "string");
}
