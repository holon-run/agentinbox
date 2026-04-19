import { UxcDaemonClient } from "@holon-run/uxc-daemon-client";
import {
  AppendSourceEventInput,
  DeliveryAttempt,
  DeliveryHandle,
  DeliveryOperationDescriptor,
  DeliveryRequest,
  FollowTemplateSpec,
  SourceSchemaField,
  SourceStream,
  SubscriptionFilter,
} from "../model";
import type { ExpandedFollowPlan, ExpandFollowTemplateInput } from "./remote_modules";

export const GITHUB_ENDPOINT = "https://api.github.com";
const DEFAULT_GITHUB_CALL_CLIENT = new UxcDaemonClient({ env: process.env });
const GITHUB_EVENT_HYDRATION_MIN_PER_PAGE = 10;
const GITHUB_EVENT_HYDRATION_MAX_PER_PAGE = 30;
const GITHUB_EVENT_HYDRATION_MAX_PAGES = 3;
const HYDRATABLE_GITHUB_REPO_EVENT_TYPES = new Set([
  "PullRequestReviewEvent",
  "PullRequestReviewCommentEvent",
]);
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
  constructor(private readonly client: GithubCallClient = DEFAULT_GITHUB_CALL_CLIENT) {}

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

  async updateIssueState(input: {
    owner: string;
    repo: string;
    issueNumber: number;
    state: "open" | "closed";
    auth?: string;
  }): Promise<void> {
    await this.client.call({
      endpoint: GITHUB_ENDPOINT,
      operation: "patch:/repos/{owner}/{repo}/issues/{issue_number}",
      payload: {
        owner: input.owner,
        repo: input.repo,
        issue_number: input.issueNumber,
        state: input.state,
      },
      options: { auth: input.auth },
    });
  }

  async mergePullRequest(input: {
    owner: string;
    repo: string;
    pullNumber: number;
    mergeMethod?: "merge" | "squash" | "rebase";
    commitTitle?: string;
    commitMessage?: string;
    auth?: string;
  }): Promise<void> {
    await this.client.call({
      endpoint: GITHUB_ENDPOINT,
      operation: "put:/repos/{owner}/{repo}/pulls/{pull_number}/merge",
      payload: {
        owner: input.owner,
        repo: input.repo,
        pull_number: input.pullNumber,
        merge_method: input.mergeMethod ?? null,
        commit_title: input.commitTitle ?? null,
        commit_message: input.commitMessage ?? null,
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
    return invokeGithubDeliveryOperation(attempt, canonicalGithubOperationForSurface(attempt.surface), { body: payloadText }, this.client);
  }
}

export function githubDeliveryOperationsForHandle(handle: DeliveryHandle): DeliveryOperationDescriptor[] {
  if (handle.surface === "review_comment") {
    return [{
      name: "reply_in_review_thread",
      title: "Reply In Review Thread",
      inputSchema: deliveryBodySchema(),
      canonicalTextAlias: true,
    }];
  }
  if (handle.surface === "issue_comment") {
    return [
      {
        name: "add_comment",
        title: "Add Comment",
        inputSchema: deliveryBodySchema(),
        canonicalTextAlias: true,
      },
      {
        name: "close_issue",
        title: "Close Issue",
        inputSchema: emptyObjectSchema(),
      },
      {
        name: "reopen_issue",
        title: "Reopen Issue",
        inputSchema: emptyObjectSchema(),
      },
    ];
  }
  if (handle.surface === "pull_request_comment") {
    return [
      {
        name: "add_comment",
        title: "Add Comment",
        inputSchema: deliveryBodySchema(),
        canonicalTextAlias: true,
      },
      {
        name: "close_issue",
        title: "Close Pull Request",
        inputSchema: emptyObjectSchema(),
      },
      {
        name: "reopen_issue",
        title: "Reopen Pull Request",
        inputSchema: emptyObjectSchema(),
      },
      {
        name: "merge_pull_request",
        title: "Merge Pull Request",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            mergeMethod: { type: "string", enum: ["merge", "squash", "rebase"] },
            commitTitle: { type: "string" },
            commitMessage: { type: "string" },
          },
        },
      },
    ];
  }
  return [];
}

export async function invokeGithubDeliveryOperation(
  handle: DeliveryHandle,
  operation: string,
  input: Record<string, unknown>,
  client: GithubUxcClient = new GithubUxcClient(),
): Promise<{ status: "sent"; note: string }> {
  const target = parseTargetRef(handle.targetRef);
  if (operation === "add_comment") {
    const body = requireDeliveryBody(input, operation);
    await client.createIssueComment({
      owner: target.owner,
      repo: target.repo,
      issueNumber: target.number,
      body,
    });
    return { status: "sent", note: "sent GitHub issue comment" };
  }
  if (operation === "reply_in_review_thread") {
    const body = requireDeliveryBody(input, operation);
    if (!handle.threadRef || !handle.threadRef.startsWith("review_comment:")) {
      throw new Error("reply_in_review_thread requires threadRef=review_comment:<id>");
    }
    await client.replyToReviewComment({
      owner: target.owner,
      repo: target.repo,
      pullNumber: target.number,
      commentId: Number(handle.threadRef.slice("review_comment:".length)),
      body,
    });
    return { status: "sent", note: "sent GitHub review comment reply" };
  }
  if (operation === "close_issue") {
    await client.updateIssueState({
      owner: target.owner,
      repo: target.repo,
      issueNumber: target.number,
      state: "closed",
    });
    return { status: "sent", note: "closed GitHub issue" };
  }
  if (operation === "reopen_issue") {
    await client.updateIssueState({
      owner: target.owner,
      repo: target.repo,
      issueNumber: target.number,
      state: "open",
    });
    return { status: "sent", note: "reopened GitHub issue" };
  }
  if (operation === "merge_pull_request") {
    await client.mergePullRequest({
      owner: target.owner,
      repo: target.repo,
      pullNumber: target.number,
      mergeMethod: asMergeMethod(input.mergeMethod),
      commitTitle: asString(input.commitTitle) ?? undefined,
      commitMessage: asString(input.commitMessage) ?? undefined,
    });
    return { status: "sent", note: "merged GitHub pull request" };
  }
  throw new Error(`unknown GitHub delivery operation: ${operation}`);
}

export function normalizeGithubRepoEvent(
  source: SourceStream,
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
  const eventId = asIdString(event.id);
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
  const url = extractGithubRepoEventUrl(event, issue, pullRequest, review, comment);
  const number =
    asNumber(issue.number)
    ?? asNumber(pullRequest.number)
    ?? asNumber(payload.number)
    ?? extractGithubNumberFromUrl(url);
  const isPullRequest = eventType.startsWith("PullRequest");
  const title = asString(issue.title) ?? asString(pullRequest.title) ?? null;
  const reviewState = asString(review.state) ?? null;
  const body = asString(comment.body) ?? asString(review.body) ?? asString(issue.body) ?? asString(pullRequest.body) ?? null;
  const labels = extractLabels(issue.labels);
  const mentions = extractMentions(title, body);
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
      merged: asBoolean(pullRequest.merged),
    },
    deliveryHandle,
  };
}

export async function hydrateGithubRepoEventIfNeeded(
  config: GithubSourceConfig,
  raw: Record<string, unknown>,
  client: GithubCallClient = DEFAULT_GITHUB_CALL_CLIENT,
): Promise<Record<string, unknown>> {
  if (!shouldHydrateGithubRepoEvent(raw)) {
    return raw;
  }

  const eventId = asIdString(raw.id);
  if (!eventId) {
    return raw;
  }

  const perPage = computeGithubHydrationPerPage(config.perPage);
  for (let page = 1; page <= GITHUB_EVENT_HYDRATION_MAX_PAGES; page += 1) {
    let response: Awaited<ReturnType<GithubCallClient["call"]>>;
    try {
      response = await client.call({
        endpoint: GITHUB_ENDPOINT,
        operation: "get:/repos/{owner}/{repo}/events",
        payload: {
          owner: config.owner,
          repo: config.repo,
          per_page: perPage,
          page,
        },
        options: { auth: config.uxcAuth },
      });
    } catch {
      return raw;
    }
    const candidates = Array.isArray(response.data) ? response.data : [];
    if (candidates.length === 0) {
      break;
    }
    for (const candidateValue of candidates) {
      const candidate = asRecord(candidateValue);
      if (asIdString(candidate.id) !== eventId) {
        continue;
      }
      return hasGithubRepoEventMetadata(candidate) ? candidate : raw;
    }
  }

  return raw;
}

export function canonicalGithubPullRequestRef(source: SourceStream, number: number): string {
  const config = parseGithubSourceConfig(source);
  return `repo:${config.owner}/${config.repo}:pr:${number}`;
}

export function canonicalGithubIssueRef(source: SourceStream, number: number): string {
  const config = parseGithubSourceConfig(source);
  return `repo:${config.owner}/${config.repo}:issue:${number}`;
}

export function deriveGithubTrackedResource(filter: SubscriptionFilter, source: SourceStream): { ref: string } | null {
  const metadata = asRecord(filter.metadata);
  const payload = asRecord(filter.payload);
  const number = asNumber(metadata.number) ?? asNumber(payload.number) ?? asNumber(payload.ref);
  const isPullRequest = asBoolean(metadata.isPullRequest);
  if (!number || isPullRequest !== true) {
    return null;
  }
  return { ref: canonicalGithubPullRequestRef(source, number) };
}

export function githubSubscriptionShortcutSpec(): Array<{
  name: string;
  description: string;
  argsSchema: SourceSchemaField[];
}> {
  return [{
    name: "pr",
    description: "Follow one pull request and auto-retire when it closes.",
    argsSchema: [
      { name: "number", type: "number", required: true, description: "Pull request number." },
      { name: "withCi", type: "boolean", required: false, description: "Also create a sibling ci_runs subscription under the same host and stream key." },
    ],
  }];
}

export function githubFollowTemplateSpec(): FollowTemplateSpec[] {
  const repoArgs: SourceSchemaField[] = [
    { name: "owner", type: "string", required: true, description: "GitHub repository owner." },
    { name: "repo", type: "string", required: true, description: "GitHub repository name." },
  ];
  return [
    {
      templateId: "github.repo",
      providerOrKind: "github",
      label: "GitHub Repository",
      description: "Follow a repository event stream.",
      argsSchema: repoArgs,
    },
    {
      templateId: "github.pr",
      providerOrKind: "github",
      label: "GitHub Pull Request",
      description: "Follow one pull request and optionally its CI.",
      argsSchema: [
        ...repoArgs,
        { name: "number", type: "number", required: true, description: "Pull request number." },
        { name: "withCi", type: "boolean", required: false, description: "Also follow the repository CI stream for that pull request." },
      ],
    },
    {
      templateId: "github.issue",
      providerOrKind: "github",
      label: "GitHub Issue",
      description: "Follow one issue without automatic terminal cleanup.",
      argsSchema: [
        ...repoArgs,
        { name: "number", type: "number", required: true, description: "Issue number." },
      ],
    },
  ];
}

export function expandGithubSubscriptionShortcut(input: {
  name: string;
  args?: Record<string, unknown>;
  source: SourceStream;
}): {
  members: Array<{
    streamKind?: string | null;
    filter?: SubscriptionFilter;
    trackedResourceRef: string;
    cleanupPolicy: { mode: "on_terminal" };
  }>;
} | null {
  if (input.name !== "pr") {
    return null;
  }
  const number = typeof input.args?.number === "number" ? input.args.number : null;
  if (!number || !Number.isInteger(number) || number <= 0) {
    throw new Error("subscription shortcut pr requires a positive integer number");
  }
  const trackedResourceRef = canonicalGithubPullRequestRef(input.source, number);
  const withCi = input.args?.withCi === true;
  return {
    members: [
      {
        streamKind: "repo_events",
        filter: {
          metadata: {
            number,
            isPullRequest: true,
          },
        },
        trackedResourceRef,
        cleanupPolicy: { mode: "on_terminal" },
      },
      ...(withCi
        ? [{
            streamKind: "ci_runs",
            filter: {
              metadata: {
                pullRequestNumbers: [number],
              },
            },
            trackedResourceRef,
            cleanupPolicy: { mode: "on_terminal" as const },
          }]
        : []),
    ],
  };
}

export function expandGithubFollowTemplate(input: ExpandFollowTemplateInput): ExpandedFollowPlan | null {
  const config = parseGithubSourceConfig(input.source);
  if (input.template === "repo") {
    return {
      templateId: "github.repo",
      sources: [
        {
          logicalName: "repo_events",
          sourceType: "github_repo",
          sourceKey: `${config.owner}/${config.repo}`,
          configRef: input.source.configRef ?? null,
          config: githubFollowSourceConfig(input.source),
        },
      ],
      subscriptions: [],
    };
  }

  const number = typeof input.args?.number === "number" ? input.args.number : null;
  if (input.template !== "pr" && input.template !== "issue") {
    return null;
  }
  if (!number || !Number.isInteger(number) || number <= 0) {
    throw new Error(`follow template github.${input.template} requires a positive integer number`);
  }

  if (input.template === "pr") {
    const trackedResourceRef = canonicalGithubPullRequestRef(input.source, number);
    const withCi = input.args?.withCi === true;
    return {
      templateId: "github.pr",
      sources: [
        {
          logicalName: "repo_events",
          sourceType: "github_repo",
          sourceKey: `${config.owner}/${config.repo}`,
          configRef: input.source.configRef ?? null,
          config: githubFollowSourceConfig(input.source),
        },
        ...(withCi
          ? [{
              logicalName: "ci_runs",
              sourceType: "github_repo_ci" as const,
              sourceKey: `${config.owner}/${config.repo}`,
              configRef: input.source.configRef ?? null,
              config: githubFollowSourceConfig(input.source),
            }]
          : []),
      ],
      subscriptions: [
        {
          sourceLogicalName: "repo_events",
          filter: {
            metadata: {
              number,
              isPullRequest: true,
            },
          },
          trackedResourceRef,
          cleanupPolicy: { mode: "on_terminal" },
        },
        ...(withCi
          ? [{
              sourceLogicalName: "ci_runs",
              filter: {
                metadata: {
                  pullRequestNumbers: [number],
                },
              },
              trackedResourceRef,
              cleanupPolicy: { mode: "on_terminal" as const },
            }]
          : []),
      ],
    };
  }

  return {
    templateId: "github.issue",
    sources: [
      {
        logicalName: "repo_events",
        sourceType: "github_repo",
        sourceKey: `${config.owner}/${config.repo}`,
        configRef: input.source.configRef ?? null,
        config: githubFollowSourceConfig(input.source),
      },
    ],
    subscriptions: [
      {
        sourceLogicalName: "repo_events",
        filter: {
          metadata: {
            number,
            isPullRequest: false,
          },
        },
        trackedResourceRef: canonicalGithubIssueRef(input.source, number),
        cleanupPolicy: { mode: "manual" },
      },
    ],
  };
}

export function projectGithubLifecycleSignal(rawPayload: Record<string, unknown>, source: SourceStream): {
  ref: string;
  terminal: boolean;
  state: string;
  result: string;
} | null {
  const eventType = asString(rawPayload.type);
  if (eventType !== "PullRequestEvent") {
    return null;
  }
  const action = asString(rawPayload.action);
  if (action !== "closed" && action !== "merged") {
    return null;
  }
  const pullRequest = asRecord(rawPayload.pull_request);
  const number = asNumber(pullRequest.number);
  if (!number) {
    return null;
  }
  const merged = action === "merged" || asBoolean(rawPayload.merged) === true || asBoolean(pullRequest.merged) === true;
  return {
    ref: canonicalGithubPullRequestRef(source, number),
    terminal: true,
    state: "closed",
    result: merged ? "merged" : "closed",
  };
}

function githubFollowSourceConfig(source: SourceStream): Record<string, unknown> {
  const config = { ...(source.config ?? {}) };
  delete config.number;
  delete config.withCi;
  return config;
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

export function parseGithubSourceConfig(source: SourceStream): GithubSourceConfig {
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

function computeGithubHydrationPerPage(perPage: number | undefined): number {
  const configured = Number.isInteger(perPage) && perPage && perPage > 0
    ? perPage
    : GITHUB_EVENT_HYDRATION_MIN_PER_PAGE;
  return Math.min(GITHUB_EVENT_HYDRATION_MAX_PER_PAGE, Math.max(GITHUB_EVENT_HYDRATION_MIN_PER_PAGE, configured));
}

function extractGithubRepoEventUrl(
  event: Record<string, unknown>,
  issue: Record<string, unknown>,
  pullRequest: Record<string, unknown>,
  review: Record<string, unknown>,
  comment: Record<string, unknown>,
): string | null {
  return (
    asString(comment.html_url)
    ?? asString(review.html_url)
    ?? asString(issue.html_url)
    ?? asString(pullRequest.html_url)
    ?? asString(comment.pull_request_url)
    ?? asString(review.pull_request_url)
    ?? asString(event.url)
  );
}

function extractGithubNumberFromUrl(url: string | null): number | null {
  if (!url) {
    return null;
  }
  const match = url.match(/\/(?:pull|pulls|issues)\/(\d+)(?:$|[/?#])/);
  return match ? Number(match[1]) : null;
}

function shouldHydrateGithubRepoEvent(raw: Record<string, unknown>): boolean {
  const eventType = asString(raw.type);
  if (!eventType || !HYDRATABLE_GITHUB_REPO_EVENT_TYPES.has(eventType)) {
    return false;
  }
  const payload = asRecord(raw.payload);
  const issue = asRecord(payload.issue);
  const pullRequest = asRecord(payload.pull_request);
  const review = asRecord(payload.review);
  const comment = asRecord(payload.comment);
  const url = extractGithubRepoEventUrl(raw, issue, pullRequest, review, comment);
  const number =
    asNumber(issue.number)
    ?? asNumber(pullRequest.number)
    ?? asNumber(payload.number)
    ?? extractGithubNumberFromUrl(url);
  if (number) {
    return false;
  }
  return [pullRequest, review, comment].some(isUxcPreviewTruncatedObject);
}

function hasGithubRepoEventMetadata(raw: Record<string, unknown>): boolean {
  const payload = asRecord(raw.payload);
  const issue = asRecord(payload.issue);
  const pullRequest = asRecord(payload.pull_request);
  const review = asRecord(payload.review);
  const comment = asRecord(payload.comment);
  return Boolean(
    asNumber(issue.number)
    ?? asNumber(pullRequest.number)
    ?? asNumber(payload.number)
    ?? extractGithubNumberFromUrl(extractGithubRepoEventUrl(raw, issue, pullRequest, review, comment))
    ?? asString(review.state)
    ?? extractGithubRepoEventUrl(raw, issue, pullRequest, review, comment),
  );
}

function isUxcPreviewTruncatedObject(value: Record<string, unknown>): boolean {
  return value._uxc_preview_truncated === true;
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

function canonicalGithubOperationForSurface(surface: string): string {
  if (surface === "issue_comment" || surface === "pull_request_comment") {
    return "add_comment";
  }
  if (surface === "review_comment") {
    return "reply_in_review_thread";
  }
  throw new Error(`deliver send only supports canonical GitHub text surfaces; use deliver invoke for ${surface}`);
}

function deliveryBodySchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["body"],
    properties: {
      body: { type: "string", minLength: 1 },
    },
  };
}

function emptyObjectSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    properties: {},
  };
}

function requireDeliveryBody(input: Record<string, unknown>, operation: string): string {
  const body = asString(input.body);
  if (!body || body.trim().length === 0) {
    throw new Error(`${operation} requires input.body`);
  }
  return body;
}

function asMergeMethod(value: unknown): "merge" | "squash" | "rebase" | undefined {
  return value === "merge" || value === "squash" || value === "rebase" ? value : undefined;
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

function asIdString(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function asStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  return value.filter((item): item is string => typeof item === "string");
}
