import test from "node:test";
import assert from "node:assert/strict";
import {
  deriveGithubTrackedResource,
  GithubDeliveryAdapter,
  GithubUxcClient,
  githubSubscriptionShortcutSpec,
  githubDeliveryOperationsForHandle,
  expandGithubSubscriptionShortcut,
  invokeGithubDeliveryOperation,
  normalizeGithubRepoEvent,
  projectGithubLifecycleSignal,
  type GithubCallClient,
} from "../src/sources/github";
import { createGithubRepoRemoteModule } from "../src/sources/remote_modules";
import { DeliveryAttempt, SourceStream, SubscriptionFilter } from "../src/model";

class FakeUxcClient implements GithubCallClient {
  public calls: Array<Record<string, unknown>> = [];
  public responses: Array<{ data: unknown }> = [];
  public errors: Error[] = [];

  async call(args: Record<string, unknown>) {
    this.calls.push(args);
    const error = this.errors.shift();
    if (error) {
      throw error;
    }
    return this.responses.shift() ?? { data: { ok: true } };
  }
}

test("normalizeGithubRepoEvent extracts metadata and delivery handle", async () => {
  const source: SourceStream = {
    sourceId: "src_1",
    sourceType: "github_repo",
    sourceKey: "holon-run/agentinbox",
    config: { owner: "holon-run", repo: "agentinbox" },
    configRef: null,
    status: "active",
    checkpoint: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const normalized = normalizeGithubRepoEvent(source, { owner: "holon-run", repo: "agentinbox" }, {
    id: "100",
    type: "IssueCommentEvent",
    created_at: "2026-04-04T11:00:00Z",
    actor: { login: "jolestar" },
    repo: { name: "holon-run/agentinbox" },
    payload: {
      action: "created",
      issue: {
        number: 12,
        title: "hello @alpha",
        body: "body",
        labels: [{ name: "agent" }],
        html_url: "https://github.com/holon-run/agentinbox/issues/12",
      },
      comment: {
        id: 999,
        body: "ping @alpha",
        html_url: "https://github.com/holon-run/agentinbox/issues/12#issuecomment-999",
      },
    },
  });

  assert.ok(normalized);
  assert.equal(normalized.eventVariant, "IssueCommentEvent.created");
  assert.deepEqual(normalized.metadata?.mentions, ["alpha"]);
  assert.deepEqual(normalized.metadata?.labels, ["agent"]);
  assert.equal(normalized.deliveryHandle?.provider, "github");
  assert.equal(normalized.deliveryHandle?.surface, "issue_comment");
  assert.equal(normalized.deliveryHandle?.targetRef, "holon-run/agentinbox#12");
});

test("normalizeGithubRepoEvent includes PullRequestReviewEvent by default", async () => {
  const source: SourceStream = {
    sourceId: "src_review",
    sourceType: "github_repo",
    sourceKey: "holon-run/agentinbox",
    config: { owner: "holon-run", repo: "agentinbox" },
    configRef: null,
    status: "active",
    checkpoint: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const normalized = normalizeGithubRepoEvent(source, { owner: "holon-run", repo: "agentinbox" }, {
    id: "200",
    type: "PullRequestReviewEvent",
    created_at: "2026-04-13T10:41:34Z",
    actor: { login: "Copilot" },
    repo: { name: "holon-run/agentinbox" },
    payload: {
      action: "created",
      review: {
        state: "commented",
        body: "review summary",
        html_url: "https://github.com/holon-run/agentinbox/pull/67#pullrequestreview-1",
      },
      pull_request: {
        number: 67,
        title: "feat: add remote module capability hooks",
        body: "body",
        html_url: "https://github.com/holon-run/agentinbox/pull/67",
      },
    },
  });

  assert.ok(normalized);
  assert.equal(normalized.eventVariant, "PullRequestReviewEvent.created");
  assert.equal(normalized.metadata?.number, 67);
  assert.equal(normalized.metadata?.isPullRequest, true);
  assert.equal(normalized.metadata?.reviewState, "commented");
  assert.equal(normalized.metadata?.body, "review summary");
  assert.equal(normalized.metadata?.url, "https://github.com/holon-run/agentinbox/pull/67#pullrequestreview-1");
  assert.deepEqual(normalized.rawPayload?.review, {
    state: "commented",
    body: "review summary",
    html_url: "https://github.com/holon-run/agentinbox/pull/67#pullrequestreview-1",
  });
  assert.equal(normalized.deliveryHandle?.surface, "issue_comment");
  assert.equal(normalized.deliveryHandle?.targetRef, "holon-run/agentinbox#67");
});

test("normalizeGithubRepoEvent derives pull request numbers from review URLs", async () => {
  const source: SourceStream = {
    sourceId: "src_review_url",
    sourceType: "github_repo",
    sourceKey: "holon-run/agentinbox",
    config: { owner: "holon-run", repo: "agentinbox" },
    configRef: null,
    status: "active",
    checkpoint: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const normalized = normalizeGithubRepoEvent(source, { owner: "holon-run", repo: "agentinbox" }, {
    id: "201",
    type: "PullRequestReviewEvent",
    created_at: "2026-04-19T10:41:34Z",
    actor: { login: "Copilot" },
    repo: { name: "holon-run/agentinbox" },
    payload: {
      action: "created",
      review: {
        state: "commented",
        html_url: "https://github.com/holon-run/agentinbox/pull/67#pullrequestreview-1",
      },
      pull_request: {},
    },
  });

  assert.ok(normalized);
  assert.equal(normalized.metadata?.number, 67);
  assert.equal(normalized.metadata?.url, "https://github.com/holon-run/agentinbox/pull/67#pullrequestreview-1");
  assert.equal(normalized.deliveryHandle?.targetRef, "holon-run/agentinbox#67");
});

test("github_repo remote module hydrates truncated review events before mapping", async () => {
  const source: SourceStream = {
    sourceId: "src_review_hydrate",
    sourceType: "github_repo",
    sourceKey: "holon-run/agentinbox",
    config: { owner: "holon-run", repo: "agentinbox", uxcAuth: "github-default" },
    configRef: null,
    status: "active",
    checkpoint: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const fake = new FakeUxcClient();
  fake.responses.push({
    data: [{
      id: "8568075837",
      type: "PullRequestReviewEvent",
      created_at: "2026-04-19T09:37:09Z",
      actor: { login: "jolestar" },
      repo: { name: "holon-run/agentinbox" },
      payload: {
        action: "created",
        review: {
          state: "approved",
          body: "ship it",
          html_url: "https://github.com/holon-run/agentinbox/pull/252#pullrequestreview-9",
        },
        pull_request: {
          number: 252,
          title: "feat: hydrate truncated review events",
          html_url: "https://github.com/holon-run/agentinbox/pull/252",
        },
      },
    }],
  });
  const module = createGithubRepoRemoteModule({ callClient: fake });

  const mapped = await module.mapRawEvent({
    id: "8568075837",
    type: "PullRequestReviewEvent",
    created_at: "2026-04-19T09:37:09Z",
    actor: { login: "jolestar" },
    repo: { name: "holon-run/agentinbox" },
    payload: {
      action: "created",
      issue: {},
      pull_request: {
        _uxc_preview_truncated: true,
        _uxc_type: "object",
      },
      review: {
        _uxc_preview_truncated: true,
        _uxc_type: "object",
      },
      comment: {},
    },
  }, source);

  assert.ok(mapped);
  assert.equal(mapped.metadata.number, 252);
  assert.equal(mapped.metadata.reviewState, "approved");
  assert.equal(mapped.metadata.url, "https://github.com/holon-run/agentinbox/pull/252#pullrequestreview-9");
  assert.equal(mapped.deliveryHandle?.targetRef, "holon-run/agentinbox#252");
  assert.equal(fake.calls.length, 1);
  assert.deepEqual(fake.calls[0], {
    endpoint: "https://api.github.com",
    operation: "get:/repos/{owner}/{repo}/events",
    payload: {
      owner: "holon-run",
      repo: "agentinbox",
      per_page: 10,
      page: 1,
    },
    options: { auth: "github-default" },
  });
});

test("github_repo remote module falls back to raw truncated review events when hydration fails", async () => {
  const source: SourceStream = {
    sourceId: "src_review_hydrate_error",
    sourceType: "github_repo",
    sourceKey: "holon-run/agentinbox",
    config: { owner: "holon-run", repo: "agentinbox", uxcAuth: "github-default" },
    configRef: null,
    status: "active",
    checkpoint: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const fake = new FakeUxcClient();
  fake.errors.push(new Error("transient github failure"));
  const module = createGithubRepoRemoteModule({ callClient: fake });

  const mapped = await module.mapRawEvent({
    id: "8568075838",
    type: "PullRequestReviewEvent",
    created_at: "2026-04-19T09:37:10Z",
    actor: { login: "jolestar" },
    repo: { name: "holon-run/agentinbox" },
    payload: {
      action: "created",
      issue: {},
      pull_request: {
        _uxc_preview_truncated: true,
        _uxc_type: "object",
      },
      review: {
        _uxc_preview_truncated: true,
        _uxc_type: "object",
      },
      comment: {},
    },
  }, source);

  assert.ok(mapped);
  assert.equal(mapped.metadata.number, null);
  assert.equal(mapped.metadata.reviewState, null);
  assert.equal(mapped.metadata.url, null);
  assert.equal(mapped.deliveryHandle, null);
  assert.equal(fake.calls.length, 1);
});

test("normalizeGithubRepoEvent preserves pull request merged state for lifecycle hooks", async () => {
  const source: SourceStream = {
    sourceId: "src_pr",
    sourceType: "github_repo",
    sourceKey: "holon-run/agentinbox",
    config: { owner: "holon-run", repo: "agentinbox" },
    configRef: null,
    status: "active",
    checkpoint: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const normalized = normalizeGithubRepoEvent(source, { owner: "holon-run", repo: "agentinbox" }, {
    id: "300",
    type: "PullRequestEvent",
    created_at: "2026-04-14T04:39:12Z",
    actor: { login: "jolestar" },
    repo: { name: "holon-run/agentinbox" },
    payload: {
      action: "closed",
      pull_request: {
        number: 72,
        title: "feat: add cleanup policy lifecycle engine",
        merged: true,
      },
    },
  });

  assert.ok(normalized);
  assert.equal(normalized.eventVariant, "PullRequestEvent.closed");
  assert.equal(normalized.rawPayload?.merged, true);
  assert.deepEqual(normalized.rawPayload?.pull_request, {
    number: 72,
    title: "feat: add cleanup policy lifecycle engine",
    merged: true,
  });
});

test("github pull request helpers derive tracked resources and terminal lifecycle results", async () => {
  const source: SourceStream = {
    sourceId: "src_pr_helpers",
    hostId: "hst_pr_helpers",
    streamKind: "repo_events",
    streamKey: "holon-run/agentinbox",
    sourceType: "github_repo",
    sourceKey: "holon-run/agentinbox",
    config: { owner: "holon-run", repo: "agentinbox" },
    configRef: null,
    status: "active",
    checkpoint: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const filter: SubscriptionFilter = {
    metadata: {
      number: 72,
      isPullRequest: true,
    },
  };
  assert.deepEqual(deriveGithubTrackedResource(filter, source), { ref: "repo:holon-run/agentinbox:pr:72" });
  assert.equal(deriveGithubTrackedResource({ metadata: { number: 72 } }, source), null);
  assert.equal(deriveGithubTrackedResource({ metadata: { number: 72, isPullRequest: false } }, source), null);

  assert.deepEqual(projectGithubLifecycleSignal({
    type: "PullRequestEvent",
    action: "closed",
    pull_request: { number: 72, merged: true },
  }, source), {
    ref: "repo:holon-run/agentinbox:pr:72",
    terminal: true,
    state: "closed",
    result: "merged",
  });
  assert.deepEqual(projectGithubLifecycleSignal({
    type: "PullRequestEvent",
    action: "closed",
    pull_request: { number: 73, merged: false },
  }, source), {
    ref: "repo:holon-run/agentinbox:pr:73",
    terminal: true,
    state: "closed",
    result: "closed",
  });
  assert.equal(projectGithubLifecycleSignal({
    type: "PullRequestEvent",
    action: "opened",
    pull_request: { number: 74 },
  }, source), null);
});

test("github subscription shortcut helpers expose and expand the builtin pr shortcut", async () => {
  assert.deepEqual(githubSubscriptionShortcutSpec(), [{
    name: "pr",
    description: "Follow one pull request and auto-retire when it closes.",
    argsSchema: [
      { name: "number", type: "number", required: true, description: "Pull request number." },
      { name: "withCi", type: "boolean", required: false, description: "Also create a sibling ci_runs subscription under the same host and stream key." },
    ],
  }]);
  const source: SourceStream = {
    sourceId: "src_pr_shortcut",
    hostId: "hst_pr_shortcut",
    streamKind: "repo_events",
    streamKey: "holon-run/agentinbox",
    sourceType: "github_repo",
    sourceKey: "holon-run/agentinbox",
    config: { owner: "holon-run", repo: "agentinbox" },
    configRef: null,
    status: "active",
    checkpoint: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  assert.deepEqual(expandGithubSubscriptionShortcut({
    name: "pr",
    args: { number: 74 },
    source,
  }), {
    members: [{
      streamKind: "repo_events",
      filter: {
        metadata: {
          number: 74,
          isPullRequest: true,
        },
      },
      trackedResourceRef: "repo:holon-run/agentinbox:pr:74",
      cleanupPolicy: { mode: "on_terminal" },
    }],
  });
  assert.deepEqual(expandGithubSubscriptionShortcut({
    name: "pr",
    args: { number: 74, withCi: true },
    source,
  }), {
    members: [
      {
        streamKind: "repo_events",
        filter: {
          metadata: {
            number: 74,
            isPullRequest: true,
          },
        },
        trackedResourceRef: "repo:holon-run/agentinbox:pr:74",
        cleanupPolicy: { mode: "on_terminal" },
      },
      {
        streamKind: "ci_runs",
        filter: {
          metadata: {
            pullRequestNumbers: [74],
          },
        },
        trackedResourceRef: "repo:holon-run/agentinbox:pr:74",
        cleanupPolicy: { mode: "on_terminal" },
      },
    ],
  });
});

test("github delivery adapter maps issue comments and review replies to uxc calls", async () => {
  const fake = new FakeUxcClient();
  const adapter = new GithubDeliveryAdapter(new GithubUxcClient(fake));
  const issueAttempt: DeliveryAttempt = {
    deliveryId: "dlv_1",
    provider: "github",
    surface: "issue_comment",
    targetRef: "holon-run/agentinbox#12",
    threadRef: null,
    replyMode: "comment",
    kind: "reply",
    payload: { text: "hello" },
    status: "accepted",
    createdAt: new Date().toISOString(),
  };
  await adapter.send({ kind: "reply", payload: { text: "hello" } } as never, issueAttempt);
  assert.equal(fake.calls[0]?.operation, "post:/repos/{owner}/{repo}/issues/{issue_number}/comments");

  const reviewAttempt: DeliveryAttempt = {
    ...issueAttempt,
    deliveryId: "dlv_2",
    surface: "review_comment",
    targetRef: "holon-run/agentinbox#34",
    threadRef: "review_comment:88",
  };
  await adapter.send({ kind: "reply", payload: { text: "review" } } as never, reviewAttempt);
  assert.equal(fake.calls[1]?.operation, "post:/repos/{owner}/{repo}/pulls/{pull_number}/comments/{comment_id}/replies");
});

test("github delivery operations expose handle-specific actions", () => {
  assert.deepEqual(
    githubDeliveryOperationsForHandle({
      provider: "github",
      surface: "pull_request_comment",
      targetRef: "holon-run/agentinbox#34",
    }).map((operation) => operation.name),
    ["add_comment", "close_issue", "reopen_issue", "merge_pull_request"],
  );
  assert.deepEqual(
    githubDeliveryOperationsForHandle({
      provider: "github",
      surface: "review_comment",
      targetRef: "holon-run/agentinbox#34",
      threadRef: "review_comment:88",
    }).map((operation) => operation.name),
    ["reply_in_review_thread"],
  );
});

test("github delivery invoke maps issue state and merge operations to uxc calls", async () => {
  const fake = new FakeUxcClient();
  const client = new GithubUxcClient(fake);

  await invokeGithubDeliveryOperation({
    provider: "github",
    surface: "issue_comment",
    targetRef: "holon-run/agentinbox#12",
  }, "close_issue", {}, client);
  assert.equal(fake.calls[0]?.operation, "patch:/repos/{owner}/{repo}/issues/{issue_number}");
  assert.equal((fake.calls[0]?.payload as Record<string, unknown>)?.state, "closed");

  await invokeGithubDeliveryOperation({
    provider: "github",
    surface: "pull_request_comment",
    targetRef: "holon-run/agentinbox#34",
  }, "merge_pull_request", { mergeMethod: "squash", commitTitle: "Ship it" }, client);
  assert.equal(fake.calls[1]?.operation, "put:/repos/{owner}/{repo}/pulls/{pull_number}/merge");
  assert.equal((fake.calls[1]?.payload as Record<string, unknown>)?.merge_method, "squash");
});
