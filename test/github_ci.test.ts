import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { AgentInboxStore } from "../src/store";
import { AgentInboxService } from "../src/service";
import { AdapterRegistry } from "../src/adapters";
import { AppendSourceEventInput, SubscriptionSource } from "../src/model";
import { nowIso } from "../src/util";
import { GithubActionsUxcClient, GithubCiSourceRuntime, normalizeGithubWorkflowRunEvent } from "../src/sources/github_ci";

class FakeGithubActionsClient {
  public calls: Array<Record<string, unknown>> = [];
  public workflowRuns: unknown[] = [];

  async call(args: Record<string, unknown>) {
    this.calls.push(args);
    return {
      data: {
        total_count: this.workflowRuns.length,
        workflow_runs: this.workflowRuns,
      },
    };
  }
}

async function makeService(): Promise<{ store: AgentInboxStore; service: AgentInboxService; adapters: AdapterRegistry; dir: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentinbox-github-ci-test-"));
  const store = await AgentInboxStore.open(path.join(dir, "agentinbox.sqlite"));
  let service: AgentInboxService;
  const adapters = new AdapterRegistry(store, async (input: AppendSourceEventInput) => service.appendSourceEvent(input));
  service = new AgentInboxService(store, adapters);
  return { store, service, adapters, dir };
}

test("normalizeGithubWorkflowRunEvent extracts workflow run metadata", () => {
  const source: SubscriptionSource = {
    sourceId: "src_ci",
    sourceType: "github_repo_ci",
    sourceKey: "holon-run/agentinbox",
    config: { owner: "holon-run", repo: "agentinbox" },
    configRef: null,
    status: "active",
    checkpoint: null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };

  const normalized = normalizeGithubWorkflowRunEvent(source, { owner: "holon-run", repo: "agentinbox" }, {
    id: 987,
    workflow_id: 321,
    name: "CI",
    display_title: "ci / test",
    status: "completed",
    conclusion: "failure",
    event: "pull_request",
    head_sha: "abc123",
    head_branch: "main",
    run_number: 14,
    run_attempt: 2,
    html_url: "https://github.com/holon-run/agentinbox/actions/runs/987",
    created_at: "2026-04-06T10:00:00Z",
    updated_at: "2026-04-06T10:05:00Z",
    actor: { login: "jolestar" },
    head_commit: { id: "abc123", message: "fix ci" },
  });

  assert.ok(normalized);
  assert.equal(normalized?.sourceNativeId, "workflow_run:987");
  assert.equal(normalized?.eventVariant, "workflow_run.completed.failure");
  assert.equal(normalized?.metadata?.headBranch, "main");
  assert.equal(normalized?.metadata?.conclusion, "failure");
  assert.equal(normalized?.deliveryHandle, null);
});

test("github_repo_ci source runtime appends workflow run events and subscriptions materialize inbox items", async () => {
  const { store, service, dir } = await makeService();
  try {
    const fake = new FakeGithubActionsClient();
    const runtime = new GithubCiSourceRuntime(store, async (input) => service.appendSourceEvent(input), new GithubActionsUxcClient(fake));
    const source: SubscriptionSource = {
      sourceId: "src_ci",
      sourceType: "github_repo_ci",
      sourceKey: "holon-run/agentinbox",
      configRef: null,
      config: { owner: "holon-run", repo: "agentinbox", uxcAuth: "github-default", perPage: 10 },
      status: "active",
      checkpoint: null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    store.insertSource(source);
    const subscription = await service.registerSubscription({
      agentId: "alpha",
      sourceId: source.sourceId,
      matchRules: { conclusion: "failure", headBranch: "main" },
      startPolicy: "earliest",
    });

    fake.workflowRuns = [
      {
        id: 1001,
        workflow_id: 10,
        name: "ci",
        display_title: "ci / test",
        status: "completed",
        conclusion: "success",
        event: "push",
        head_sha: "sha-success",
        head_branch: "main",
        run_number: 1,
        run_attempt: 1,
        html_url: "https://github.com/holon-run/agentinbox/actions/runs/1001",
        created_at: "2026-04-06T10:00:00Z",
        updated_at: "2026-04-06T10:00:10Z",
        actor: { login: "jolestar" },
      },
      {
        id: 1002,
        workflow_id: 10,
        name: "ci",
        display_title: "ci / test",
        status: "completed",
        conclusion: "failure",
        event: "pull_request",
        head_sha: "sha-failure",
        head_branch: "main",
        run_number: 2,
        run_attempt: 1,
        html_url: "https://github.com/holon-run/agentinbox/actions/runs/1002",
        created_at: "2026-04-06T10:01:00Z",
        updated_at: "2026-04-06T10:01:30Z",
        actor: { login: "jolestar" },
      },
    ];

    await runtime.ensureSource(source);
    const sourceResult = await runtime.pollSource(source.sourceId);
    const subscriptionResult = await service.pollSubscription(subscription.subscriptionId);
    const items = service.listInboxItems(subscription.inboxId);

    assert.equal(fake.calls[0]?.operation, "get:/repos/{owner}/{repo}/actions/runs");
    assert.equal(sourceResult.appended, 2);
    assert.equal(subscriptionResult.inboxItemsCreated, 1);
    assert.equal(items.length, 1);
    assert.equal(items[0]?.metadata?.conclusion, "failure");
    assert.equal(items[0]?.eventVariant, "workflow_run.completed.failure");
  } finally {
    await service.stop();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
