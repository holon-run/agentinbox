import test from "node:test";
import assert from "node:assert/strict";
import { GithubDeliveryAdapter, GithubUxcClient, normalizeGithubRepoEvent, type GithubCallClient } from "../src/sources/github";
import { DeliveryAttempt, SubscriptionSource } from "../src/model";

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
