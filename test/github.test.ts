import test from "node:test";
import assert from "node:assert/strict";
import {
  deriveGithubTrackedResource,
  GithubDeliveryAdapter,
  GithubUxcClient,
  normalizeGithubRepoEvent,
  projectGithubLifecycleSignal,
  type GithubCallClient,
} from "../src/sources/github";
import { DeliveryAttempt, SubscriptionSource, SubscriptionFilter } from "../src/model";

class FakeUxcClient implements GithubCallClient {
  public calls: Array<Record<string, unknown>> = [];

  async call(args: Record<string, unknown>) {
    this.calls.push(args);
    return { data: { ok: true } };
  }
}

test("normalizeGithubRepoEvent extracts metadata and delivery handle", async () => {
  const source: SubscriptionSource = {
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
  const source: SubscriptionSource = {
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

test("normalizeGithubRepoEvent preserves pull request merged state for lifecycle hooks", async () => {
  const source: SubscriptionSource = {
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
  const filter: SubscriptionFilter = {
    metadata: {
      number: 72,
      isPullRequest: true,
    },
  };
  assert.deepEqual(deriveGithubTrackedResource(filter), { ref: "pr:72" });
  assert.equal(deriveGithubTrackedResource({ metadata: { number: 72, isPullRequest: false } }), null);

  assert.deepEqual(projectGithubLifecycleSignal({
    type: "PullRequestEvent",
    action: "closed",
    pull_request: { number: 72, merged: true },
  }), {
    ref: "pr:72",
    terminal: true,
    state: "closed",
    result: "merged",
  });
  assert.deepEqual(projectGithubLifecycleSignal({
    type: "PullRequestEvent",
    action: "closed",
    pull_request: { number: 73, merged: false },
  }), {
    ref: "pr:73",
    terminal: true,
    state: "closed",
    result: "closed",
  });
  assert.equal(projectGithubLifecycleSignal({
    type: "PullRequestEvent",
    action: "opened",
    pull_request: { number: 74 },
  }), null);
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
