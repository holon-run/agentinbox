import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { AgentInboxStore } from "../src/store";
import { AgentInboxService } from "../src/service";
import { AdapterRegistry } from "../src/adapters";
import { GithubDeliveryAdapter, GithubSourceRuntime, GithubUxcClient, normalizeGithubRepoEvent, type UxcLikeClient } from "../src/sources/github";
import { AppendSourceEventInput, DeliveryAttempt, SubscriptionSource } from "../src/model";
import { nowIso } from "../src/util";
import { TerminalDispatcher } from "../src/terminal";

class FakeUxcClient implements UxcLikeClient {
  public started: Array<Record<string, unknown>> = [];
  public calls: Array<Record<string, unknown>> = [];
  public jobs = new Map<string, { status: string; events: Array<{ event_kind: string; data?: unknown }> }>();

  async subscribeStart(args: Record<string, unknown>) {
    this.started.push(args);
    const jobId = `job-${this.started.length}`;
    this.jobs.set(jobId, { status: "running", events: [] });
    return {
      job_id: jobId,
      mode: "poll" as const,
      protocol: "openapi",
      endpoint: "https://api.github.com",
      sink: "memory:",
      status: "running",
    };
  }

  async subscribeStatus(jobId: string) {
    const job = this.jobs.get(jobId);
    if (!job) {
      throw new Error("missing job");
    }
    return { status: job.status };
  }

  async subscriptionEvents(args: { jobId: string; afterSeq?: number }) {
    const job = this.jobs.get(args.jobId);
    if (!job) {
      throw new Error("missing job");
    }
    const events = job.events;
    job.events = [];
    return {
      status: job.status,
      events: events.map((event, index) => ({
        version: "v1",
        job_id: args.jobId,
        seq: (args.afterSeq ?? 0) + index + 1,
        timestamp_unix: Date.now(),
        protocol: "openapi",
        source_kind: "poll",
        event_kind: event.event_kind,
        data: event.data,
        meta: {},
      })),
      next_after_seq: (args.afterSeq ?? 0) + events.length,
      has_more: false,
    };
  }

  async call(args: Record<string, unknown>) {
    this.calls.push(args);
    return { data: { ok: true } };
  }
}

async function makeService(): Promise<{ store: AgentInboxStore; service: AgentInboxService; adapters: AdapterRegistry; dir: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentinbox-github-test-"));
  const store = await AgentInboxStore.open(path.join(dir, "agentinbox.sqlite"));
  let service: AgentInboxService;
  const adapters = new AdapterRegistry(store, async (input: AppendSourceEventInput) => service.appendSourceEvent(input));
  service = new AgentInboxService(store, adapters, undefined, undefined, undefined, new TerminalDispatcher(async () => ({
    stdout: "",
    stderr: "",
  })));
  return { store, service, adapters, dir };
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

test("github source runtime appends stream events and subscriptions materialize inbox items", async () => {
  const { store, service, dir } = await makeService();
  try {
    const fake = new FakeUxcClient();
    const runtime = new GithubSourceRuntime(store, async (input) => service.appendSourceEvent(input), new GithubUxcClient(fake));
    const source: SubscriptionSource = {
      sourceId: "src_github",
      sourceType: "github_repo",
      sourceKey: "holon-run/agentinbox",
      configRef: null,
      config: { owner: "holon-run", repo: "agentinbox", uxcAuth: "github-default" },
      status: "active",
      checkpoint: null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    store.insertSource(source);
    const agent = service.registerAgent({
      backend: "tmux",
      runtimeKind: "codex",
      runtimeSessionId: "github-thread",
      tmuxPaneId: "%201",
    });
    const subscription = await service.registerSubscription({
      agentId: agent.agent.agentId,
      sourceId: source.sourceId,
      matchRules: { mentions: ["alpha"] },
      startPolicy: "earliest",
    });

    await runtime.ensureSource(source);
    const checkpoint = JSON.parse(store.getSource(source.sourceId)?.checkpoint ?? "{}") as { uxcJobId: string };
    fake.jobs.get(checkpoint.uxcJobId)?.events.push({
      event_kind: "data",
      data: {
        id: "200",
        type: "IssueCommentEvent",
        created_at: "2026-04-04T11:00:00Z",
        actor: { login: "jolestar" },
        repo: { name: "holon-run/agentinbox" },
        payload: {
          action: "created",
          issue: { number: 7, title: "task", body: "task", labels: [] },
          comment: { id: 9, body: "hello @alpha" },
        },
      },
    });

    const sourceResult = await runtime.pollSource(source.sourceId);
    const subscriptionResult = await service.pollSubscription(subscription.subscriptionId);
    assert.equal(sourceResult.appended, 1);
    assert.equal(subscriptionResult.inboxItemsCreated, 1);
    assert.equal(service.listInboxItems(subscription.agentId).length, 1);
  } finally {
    await service.stop();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
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
