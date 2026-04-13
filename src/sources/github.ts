import { UxcDaemonClient } from "@holon-run/uxc-daemon-client";
import {
  AppendSourceEventInput,
  DeliveryAttempt,
  DeliveryHandle,
  DeliveryRequest,
  SubscriptionSource,
} from "../model";

export const GITHUB_ENDPOINT = "https://api.github.com";
export const DEFAULT_GITHUB_EVENT_TYPES = [
  "IssuesEvent",
  "IssueCommentEvent",
  "PullRequestEvent",
  "PullRequestReviewEvent",
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

export interface GithubCallClient {
  call(args: {
    endpoint: string;
    operation: string;
    payload?: Record<string, unknown>;
    options?: { auth?: string };
  }): Promise<{ data: unknown }>;
}

export class GithubUxcClient {
  constructor(private readonly client: GithubCallClient = new UxcDaemonClient({ env: process.env })) {}

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
): AppendSourceEventInput | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const event = raw as Record<string, unknown>;
  const eventType = asString(event.type);
  if (!eventType || !(config.eventTypes ?? DEFAULT_GITHUB_EVENT_TYPES).includes(eventType)) {
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
  const review = asRecord(payload.review);
  const comment = asRecord(payload.comment);
  const action = asString(payload.action) ?? "observed";

  const number = asNumber(issue.number) ?? asNumber(pullRequest.number);
  const isPullRequest = eventType.startsWith("PullRequest");
  const title = asString(issue.title) ?? asString(pullRequest.title) ?? null;
  const reviewState = asString(review.state) ?? null;
  const body = asString(comment.body) ?? asString(review.body) ?? asString(issue.body) ?? asString(pullRequest.body) ?? null;
  const labels = extractLabels(issue.labels);
  const mentions = extractMentions(title, body);
  const url =
    asString(comment.html_url) ??
    asString(review.html_url) ??
    asString(issue.html_url) ??
    asString(pullRequest.html_url) ??
    asString(event.url);
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
      reviewState,
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
      review,
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

export function parseGithubSourceConfig(source: SubscriptionSource): GithubSourceConfig {
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
      eventTypes: asStringArray(config.eventTypes) ?? DEFAULT_GITHUB_EVENT_TYPES,
    };
  }
  return {
    owner,
    repo,
    uxcAuth: asString(config.uxcAuth) ?? asString(config.credentialRef) ?? undefined,
    pollIntervalSecs: asNumber(config.pollIntervalSecs) ?? 30,
    perPage: asNumber(config.perPage) ?? 10,
    eventTypes: asStringArray(config.eventTypes) ?? DEFAULT_GITHUB_EVENT_TYPES,
  };
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
