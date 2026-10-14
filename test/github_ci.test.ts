import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { AgentInboxStore } from "../src/store";
import { AgentInboxService } from "../src/service";
import { AdapterRegistry } from "../src/adapters";
import { ActivationItem, AppendSourceEventInput, DigestThreadFlushContext, SourceStream } from "../src/model";
import { nowIso } from "../src/util";
import {
  GithubActionsUxcClient,
  GithubCiSourceRuntime,
  decideGithubCiDigestFlush,
  deriveGithubCiNotificationGrouping,
  normalizeGithubWorkflowRunEvent,
  parseGithubCiSourceConfig,
  summarizeGithubCiDigestThread,
} from "../src/sources/github_ci";
import { TerminalDispatcher } from "../src/terminal";
import { RemoteSourceModuleRegistry } from "../src/sources/remote_modules";

class FakeGithubActionsClient {
  public calls: Array<Record<string, unknown>> = [];
  public workflowRuns: unknown[] = [];
  public error: Error | null = null;
  public listWorkflowRunsImpl: ((args: Record<string, unknown>) => Promise<unknown[]>) | null = null;

  async call(args: Record<string, unknown>) {
    this.calls.push(args);
    if (this.listWorkflowRunsImpl) {
      const workflowRuns = await this.listWorkflowRunsImpl(args);
      return {
        data: {
          total_count: workflowRuns.length,
          workflow_runs: workflowRuns,
        },
      };
    }
    if (this.error) {
      throw this.error;
    }
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
  service = new AgentInboxService(store, adapters, undefined, undefined, undefined, new TerminalDispatcher(async () => ({
    stdout: "",
    stderr: "",
  })));
  return { store, service, adapters, dir };
}

test("normalizeGithubWorkflowRunEvent extracts workflow run metadata", () => {
  const source: SourceStream = {
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
    head_repository: { full_name: "holon-run/agentinbox" },
    run_number: 14,
    run_attempt: 2,
    html_url: "https://github.com/holon-run/agentinbox/actions/runs/987",
    created_at: "2026-04-06T10:00:00Z",
    updated_at: "2026-04-06T10:05:00Z",
    actor: { login: "jolestar" },
    head_commit: { id: "abc123", message: "fix ci" },
    pull_requests: [{ number: 93 }, { number: 91 }, { number: 93 }],
  });

  assert.ok(normalized);
  assert.equal(normalized?.sourceNativeId, "workflow_run:987");
  assert.equal(normalized?.eventVariant, "workflow_run.ci.completed.failure.attempt_2");
  assert.equal(normalized?.metadata?.headBranch, "main");
  assert.equal(normalized?.metadata?.headRepositoryFullName, "holon-run/agentinbox");
  assert.equal(normalized?.metadata?.conclusion, "failure");
  assert.equal(normalized?.metadata?.workflowId, 321);
  assert.equal(normalized?.metadata?.runAttempt, 2);
  assert.equal(normalized?.metadata?.createdAt, "2026-04-06T10:00:00Z");
  assert.equal(normalized?.metadata?.runCreatedAt, "2026-04-06T10:00:00Z");
  assert.equal(normalized?.rawPayload?.created_at, "2026-04-06T10:00:00Z");
  assert.equal(normalized?.rawPayload?.updated_at, "2026-04-06T10:05:00Z");
  assert.deepEqual(normalized?.metadata?.pullRequestNumbers, [91, 93]);
  assert.deepEqual(normalized?.rawPayload?.head_repository, { full_name: "holon-run/agentinbox" });
  assert.deepEqual(normalized?.rawPayload?.pull_requests, [{ number: 91 }, { number: 93 }]);
  assert.equal(normalized?.deliveryHandle, null);
});

test("normalizeGithubWorkflowRunEvent distinguishes rerun attempts while preserving first-attempt identities", () => {
  const source = { sourceId: "src_ci" } as SourceStream;
  const config = { owner: "holon-run", repo: "agentinbox" };
  for (const [status, conclusion] of [
    ["in_progress", null], ["completed", "success"], ["completed", "failure"],
  ] as const) {
    const run = { id: 987, name: "CI", status, conclusion };
    const normalize = (attempt?: number) => normalizeGithubWorkflowRunEvent(
      source, config, { ...run, run_attempt: attempt },
    )!;
    const first = normalize(1);
    const second = normalize(2);
    assert.equal(first.eventVariant, `workflow_run.ci.${status}${conclusion ? `.${conclusion}` : ""}`);
    assert.equal(normalize().eventVariant, first.eventVariant);
    assert.equal(second.sourceNativeId, first.sourceNativeId);
    assert.equal(second.eventVariant, `${first.eventVariant}.attempt_2`);
    assert.equal(normalize(2).eventVariant, second.eventVariant);
    assert.equal(normalize(3).eventVariant, `${first.eventVariant}.attempt_3`);
    assert.equal(second.metadata?.runAttempt, 2);
    assert.equal(second.rawPayload?.run_attempt, 2);
  }
});

test("normalizeGithubWorkflowRunEvent falls back to observed status and display title", () => {
  const source: SourceStream = {
    sourceId: "src_ci_observed",
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
    id: 654,
    display_title: "Nightly Checks",
    conclusion: null,
  });

  assert.ok(normalized);
  assert.equal(normalized?.eventVariant, "workflow_run.nightly_checks.observed");
  assert.equal(normalized?.metadata?.name, "Nightly Checks");
  assert.equal(normalized?.metadata?.status, "observed");
  assert.deepEqual(normalized?.metadata?.pullRequestNumbers, []);
});

function ciActivationItem(overrides: {
  itemId?: string;
  occurredAt?: string;
  metadata?: Record<string, unknown>;
}): ActivationItem {
  return {
    itemId: overrides.itemId ?? "itm_ci_digest",
    sourceId: "src_ci_digest",
    sourceNativeId: "workflow_run:1001",
    eventVariant: "workflow_run.ci.completed.failure",
    inboxId: "inb_ci_digest",
    occurredAt: overrides.occurredAt ?? "2026-04-06T10:00:00Z",
    metadata: overrides.metadata ?? {},
    rawPayload: {},
  };
}

const CI_DIGEST_CONFIG = {
  owner: "holon-run",
  repo: "agentinbox",
  uxcAuth: "github-default",
  perPage: 20,
};

const CI_BARRIER_CONFIG = { ...CI_DIGEST_CONFIG, expectedWorkflowIds: [10, 20] };
const CI_CONTEXT: DigestThreadFlushContext = {
  threadCreatedAt: "2026-04-06T10:00:00Z",
  lastItemAt: "2026-04-06T10:00:30Z",
  now: "2026-04-06T10:01:00Z",
};

function policyRun(
  runId: number, workflowId: number, conclusion: string | null,
  extra: Record<string, unknown> = {},
): ActivationItem {
  return ciActivationItem({
    itemId: `run-${runId}`,
    metadata: {
      workflowRunId: runId, workflowId, runAttempt: 1,
      headSha: "sha-current", repoFullName: "holon-run/agentinbox", pullRequestNumbers: [72],
      name: `Workflow ${workflowId}`, createdAt: "2026-04-06T10:00:00Z",
      updatedAt: "2026-04-06T10:00:30Z",
      status: conclusion ? "completed" : "in_progress", conclusion, ...extra,
    },
  });
}

test("CI policy requires an explicit complete workflow barrier, never a quiet window", () => {
  const success = policyRun(1, 10, "success");
  assert.equal(decideGithubCiDigestFlush([success], CI_DIGEST_CONFIG, CI_CONTEXT).flush, false);
  assert.equal(decideGithubCiDigestFlush([success], CI_BARRIER_CONFIG, CI_CONTEXT).flush, false);
  const complete = decideGithubCiDigestFlush([success, policyRun(2, 20, "success")], CI_BARRIER_CONFIG, CI_CONTEXT);
  assert.equal(complete.flush, true);
  assert.match(complete.summary ?? "", /all expected workflows succeeded/);
  const timeout = decideGithubCiDigestFlush([success], CI_DIGEST_CONFIG, {
    ...CI_CONTEXT, now: "2026-04-06T11:01:00Z",
  });
  assert.equal(timeout.flush, true);
  assert.match(timeout.summary ?? "", /incomplete.*expected workflow set unknown/);
  assert.doesNotMatch(timeout.summary ?? "", /all expected workflows succeeded/);
});

test("CI policy includes observed workflows outside the expected set in failure alerts", () => {
  const first = decideGithubCiDigestFlush([policyRun(3, 30, "failure")], CI_BARRIER_CONFIG, CI_CONTEXT);
  assert.equal(first.flush, true);
  assert.match(first.summary ?? "", /first failure.*1 failed/);
  assert.ok(first.notificationState);
  const final = decideGithubCiDigestFlush(
    [policyRun(1, 10, "success"), policyRun(2, 20, "success")],
    CI_BARRIER_CONFIG, { ...CI_CONTEXT, notificationState: first.notificationState },
  );
  assert.equal(final.flush, true);
  assert.match(final.summary ?? "", /final.*1 failed/);
  assert.doesNotMatch(final.summary ?? "", /all expected workflows succeeded/);
});

test("CI policy waits for observed extra workflows before certifying success", () => {
  const expected = [policyRun(1, 10, "success"), policyRun(2, 20, "success")];
  const pending = [...expected, policyRun(3, 30, null)];
  assert.equal(decideGithubCiDigestFlush(pending, CI_BARRIER_CONFIG, CI_CONTEXT).flush, false);
  const timeout = decideGithubCiDigestFlush(pending, CI_BARRIER_CONFIG, {
    ...CI_CONTEXT, now: "2026-04-06T11:01:00Z",
  });
  assert.equal(timeout.flush, true);
  assert.match(timeout.summary ?? "", /incomplete.*1 still running/);
  assert.ok(timeout.notificationState);
  const final = decideGithubCiDigestFlush(
    [policyRun(3, 30, "success")], CI_BARRIER_CONFIG,
    { ...CI_CONTEXT, notificationState: timeout.notificationState },
  );
  assert.equal(final.flush, true);
  assert.match(final.summary ?? "", /all expected workflows succeeded.*3 passed/);
});

test("CI policy admits first actionable failure immediately and retains running evidence across ack", () => {
  const config = { ...CI_DIGEST_CONFIG, expectedWorkflowIds: [10, 20, 30] };
  for (const conclusion of ["failure", "timed_out", "action_required", "startup_failure"]) {
    const first = decideGithubCiDigestFlush(
      [policyRun(1, 10, conclusion), policyRun(2, 20, null), policyRun(3, 30, null)], config, CI_CONTEXT,
    );
    assert.equal(first.flush, true, conclusion);
    assert.match(first.summary ?? "", /first failure/);
    assert.ok(first.notificationState);
    const afterAck = { ...CI_CONTEXT, notificationState: first.notificationState };
    assert.equal(decideGithubCiDigestFlush([policyRun(2, 20, "failure")], config, afterAck).flush, false);
    const final = decideGithubCiDigestFlush([policyRun(2, 20, "failure"), policyRun(3, 30, "success")], config, afterAck);
    assert.equal(final.flush, true);
    assert.match(final.summary ?? "", /final.*2 failed/);
    const replay = { ...CI_CONTEXT, notificationState: final.notificationState };
    assert.equal(decideGithubCiDigestFlush([policyRun(2, 20, "failure")], config, replay).flush, false);
  }
});

test("CI policy treats cancelled, skipped and neutral as non-success, non-urgent", () => {
  for (const conclusion of ["cancelled", "skipped", "neutral"]) {
    assert.equal(decideGithubCiDigestFlush([policyRun(1, 10, conclusion)], CI_BARRIER_CONFIG, CI_CONTEXT).flush, false);
    const final = decideGithubCiDigestFlush(
      [policyRun(1, 10, conclusion), policyRun(2, 20, "success")], CI_BARRIER_CONFIG, CI_CONTEXT,
    );
    assert.equal(final.flush, true);
    assert.match(final.summary ?? "", new RegExp(conclusion));
    assert.doesNotMatch(final.summary ?? "", /all expected workflows succeeded|failed:/);
  }
});

test("CI policy rerun attempts and replacement runs open a new generation without accepting stale outcomes", () => {
  const first = decideGithubCiDigestFlush(
    [policyRun(1, 10, "failure"), policyRun(2, 20, "success")], CI_BARRIER_CONFIG, CI_CONTEXT,
  );
  const context = { ...CI_CONTEXT, notificationState: first.notificationState };
  const retry = policyRun(1, 10, null, { runAttempt: 2, updatedAt: "2026-04-06T10:01:00Z" });
  assert.equal(decideGithubCiDigestFlush([retry], CI_BARRIER_CONFIG, context).flush, false);
  const recovered = decideGithubCiDigestFlush(
    [retry, policyRun(1, 10, "success", { runAttempt: 2 }), policyRun(1, 10, "failure")],
    CI_BARRIER_CONFIG, context,
  );
  assert.equal(recovered.flush, true);
  assert.match(recovered.summary ?? "", /all expected workflows succeeded/);
  const replacement = decideGithubCiDigestFlush(
    [policyRun(3, 10, "failure", { createdAt: "2026-04-06T10:02:00Z" })],
    CI_BARRIER_CONFIG, { ...CI_CONTEXT, notificationState: recovered.notificationState },
  );
  assert.equal(replacement.flush, true);
  assert.match(replacement.summary ?? "", /first failure/);
  assert.equal(decideGithubCiDigestFlush(
    [policyRun(1, 10, "failure")], CI_BARRIER_CONFIG,
    { ...CI_CONTEXT, notificationState: replacement.notificationState },
  ).flush, false);
});

test("CI policy ranks SHA cycles by run creation, not old runs finishing late", () => {
  const previous = policyRun(1, 10, "failure", { headSha: "sha-old", createdAt: "2026-04-06T09:00:00Z" });
  const current = policyRun(2, 10, "success");
  const other = policyRun(3, 20, "success");
  const final = decideGithubCiDigestFlush([previous, current, other], CI_BARRIER_CONFIG, CI_CONTEXT);
  assert.equal(final.flush, true);
  assert.match(final.summary ?? "", /sha-cur/);
  assert.doesNotMatch(final.summary ?? "", /failed|sha-old/);
  const delayed = { ...previous, occurredAt: "2026-04-06T12:00:00Z" };
  assert.equal(decideGithubCiDigestFlush([delayed], CI_BARRIER_CONFIG, {
    ...CI_CONTEXT, notificationState: final.notificationState,
  }).flush, false);
});

test("CI policy starts a new SHA timeout at its earliest workflow after a committed snapshot", () => {
  const previous = decideGithubCiDigestFlush(
    [policyRun(1, 10, "success"), policyRun(2, 20, "success")], CI_BARRIER_CONFIG, CI_CONTEXT,
  );
  assert.equal(previous.flush, true);
  const early = policyRun(3, 10, "success", {
    headSha: "sha-next", createdAt: "2026-04-06T10:10:00Z", updatedAt: "2026-04-06T10:11:00Z",
  });
  const late = policyRun(4, 20, null, {
    headSha: "sha-next", createdAt: "2026-04-06T10:30:00Z", updatedAt: "2026-04-06T10:31:00Z",
  });
  const context = { ...CI_CONTEXT, notificationState: previous.notificationState };
  for (const items of [[early, late], [late, early]]) {
    assert.equal(decideGithubCiDigestFlush(items, CI_BARRIER_CONFIG, {
      ...context, now: "2026-04-06T11:09:00Z",
    }).flush, false, "the new SHA must not inherit the previous SHA's deadline");
    const timeout = decideGithubCiDigestFlush(items, CI_BARRIER_CONFIG, {
      ...context, now: "2026-04-06T11:11:00Z",
    });
    assert.equal(timeout.flush, true, "later workflows must not extend the new SHA's deadline");
    assert.equal(timeout.notificationState?.startedAt, "2026-04-06T10:10:00Z");
    assert.match(timeout.summary ?? "", /incomplete.*1 still running/);
    assert.equal(decideGithubCiDigestFlush(items, CI_BARRIER_CONFIG, {
      ...context, now: "2026-04-06T11:12:00Z", notificationState: timeout.notificationState,
    }).flush, false, "the committed incomplete snapshot must suppress replay");
  }
});

test("CI policy keeps the persisted SHA when a late completion cannot prove creation order", () => {
  const current = decideGithubCiDigestFlush(
    [policyRun(2, 10, "success"), policyRun(3, 20, "success")], CI_BARRIER_CONFIG, CI_CONTEXT,
  );
  assert.equal(current.flush, true);
  const lateCompletion = (metadata: Record<string, unknown>) => ciActivationItem({
    itemId: "late-completion",
    occurredAt: "2026-04-06T12:00:00Z",
    metadata: {
      workflowRunId: 1, workflowId: 10, runAttempt: 1, headSha: "sha-old",
      status: "completed", conclusion: "failure", name: "Workflow 10",
      repoFullName: "holon-run/agentinbox", pullRequestNumbers: [72],
      updatedAt: "2026-04-06T12:00:00Z", ...metadata,
    },
  });
  const withOlderRunCreatedAt = decideGithubCiDigestFlush(
    [lateCompletion({ runCreatedAt: "2026-04-06T09:00:00Z" })], CI_BARRIER_CONFIG,
    { ...CI_CONTEXT, notificationState: current.notificationState },
  );
  assert.equal(withOlderRunCreatedAt.flush, false,
    "a late old-SHA completion whose runCreatedAt predates the persisted head must not switch back");
  const withoutCreationProof = decideGithubCiDigestFlush(
    [lateCompletion({})], CI_BARRIER_CONFIG,
    { ...CI_CONTEXT, notificationState: current.notificationState },
  );
  assert.equal(withoutCreationProof.flush, false,
    "an old-SHA completion with no runCreatedAt must stay conservative instead of notifying");
  const unprovenNewSha = ciActivationItem({
    itemId: "unproven-new-sha",
    occurredAt: "2026-04-06T12:00:00Z",
    metadata: {
      workflowRunId: 5, workflowId: 10, runAttempt: 1, headSha: "sha-next",
      status: "completed", conclusion: "failure", name: "Workflow 10",
      repoFullName: "holon-run/agentinbox", pullRequestNumbers: [72],
      updatedAt: "2026-04-06T12:00:00Z",
    },
  });
  assert.equal(decideGithubCiDigestFlush([unprovenNewSha], CI_BARRIER_CONFIG, {
    ...CI_CONTEXT, notificationState: current.notificationState,
  }).flush, false, "a failure that cannot prove it belongs to the current generation must not notify");
});

test("CI config validates non-empty unique positive integer expected workflow ids", () => {
  const source = {
    sourceId: "ci-config", sourceKey: "holon-run/agentinbox",
    config: { expectedWorkflowIds: [10, 20] },
  } as unknown as SourceStream;
  assert.deepEqual(parseGithubCiSourceConfig(source).expectedWorkflowIds, [10, 20]);
  for (const invalid of [[], [10, 10], [0], [-1], [1.5], ["10"], "10"]) {
    assert.throws(() => parseGithubCiSourceConfig({
      ...source, config: { owner: "holon-run", repo: "agentinbox", expectedWorkflowIds: invalid },
    }), /expectedWorkflowIds/);
  }
});

test("CI policy rerun does not urgently re-notify an unchanged failure in another workflow", () => {
  const first = decideGithubCiDigestFlush(
    [policyRun(1, 10, "failure"), policyRun(2, 20, "success")], CI_BARRIER_CONFIG, CI_CONTEXT,
  );
  const rerun = policyRun(2, 20, null, { runAttempt: 2, updatedAt: "2026-04-06T10:02:00Z" });
  assert.equal(decideGithubCiDigestFlush([rerun], CI_BARRIER_CONFIG, {
    ...CI_CONTEXT, notificationState: first.notificationState,
  }).flush, false);
});

test("CI policy timeout is stable while a new attempt or SHA waits without a committed snapshot", () => {
  const first = decideGithubCiDigestFlush(
    [policyRun(1, 10, "failure"), policyRun(2, 20, "success")], CI_BARRIER_CONFIG, CI_CONTEXT,
  );
  const context = { ...CI_CONTEXT, notificationState: first.notificationState, now: "2026-04-06T11:03:00Z" };
  const retry = policyRun(1, 10, null, { runAttempt: 2, updatedAt: "2026-04-06T10:02:00Z" });
  const retryTimeout = decideGithubCiDigestFlush([retry], CI_BARRIER_CONFIG, context);
  assert.equal(retryTimeout.flush, true);
  assert.match(retryTimeout.summary ?? "", /incomplete/);
  const newerSha = policyRun(3, 10, null, { headSha: "sha-new", createdAt: "2026-04-06T10:02:00Z" });
  const shaTimeout = decideGithubCiDigestFlush([newerSha], CI_BARRIER_CONFIG, context);
  assert.equal(shaTimeout.flush, true);
  assert.match(shaTimeout.summary ?? "", /incomplete.*missing workflows: 20/);
});

for (const scenario of ["new SHA", "new attempt", "new attempt without prior evidence"]) {
  test(`CI policy starts the timeout from ${scenario} when no snapshot was committed`, () => {
    const oldRun = policyRun(1, 10, null);
    const context = { ...CI_CONTEXT, notificationState: null };
    const oldPending = decideGithubCiDigestFlush([oldRun], CI_BARRIER_CONFIG, {
      ...context, now: "2026-04-06T10:58:00Z",
    });
    assert.equal(oldPending.flush, false);
    assert.equal(oldPending.notificationState, undefined);
    const generationStartedAt = "2026-04-06T10:59:00Z";
    const metadata = scenario === "new SHA"
      ? { headSha: "sha-next", createdAt: generationStartedAt, updatedAt: generationStartedAt }
      : { runAttempt: 2, updatedAt: generationStartedAt };
    const newRun = policyRun(scenario === "new SHA" ? 2 : 1, 10, null, metadata);
    const items = scenario === "new attempt without prior evidence" ? [newRun] : [oldRun, newRun];
    const pending = decideGithubCiDigestFlush(items, CI_BARRIER_CONFIG, {
      ...context, now: "2026-04-06T11:00:00Z",
    });
    assert.equal(pending.flush, false, "a new generation must not inherit the old thread's timeout");
    assert.equal(pending.recheckAfterMs, 30_000);
    const updatedItems = [...items, policyRun(scenario === "new SHA" ? 2 : 1, 10, null, {
      ...metadata, updatedAt: "2026-04-06T11:01:00Z",
    })];
    assert.equal(decideGithubCiDigestFlush(updatedItems, CI_BARRIER_CONFIG, {
      ...context, now: "2026-04-06T11:58:00Z",
    }).flush, false);
    const timeout = decideGithubCiDigestFlush(updatedItems, CI_BARRIER_CONFIG, {
      ...context, now: "2026-04-06T11:59:00Z",
    });
    assert.equal(timeout.flush, true, "rechecks must not reset the generation's own hard timeout");
    assert.match(timeout.summary ?? "", /incomplete/);
    assert.equal(timeout.notificationState?.startedAt, generationStartedAt);
  });
}

for (const attempt of [1, 2]) {
  test(`CI policy reconstructs same-SHA replacement run attempt ${attempt} before a snapshot exists`, () => {
    const startedAt = "2026-04-06T10:59:00Z";
    const replacement = policyRun(2, 10, null, {
      runAttempt: attempt,
      createdAt: attempt === 1 ? startedAt : "2026-04-06T10:30:00Z",
      updatedAt: startedAt,
    });
    const items = [policyRun(1, 10, null), replacement];
    const context = { ...CI_CONTEXT, notificationState: null };
    assert.equal(decideGithubCiDigestFlush(items, CI_BARRIER_CONFIG, {
      ...context, now: "2026-04-06T11:00:00Z",
    }).flush, false, "multiple run IDs must not inherit the original run's timeout");
    const updatedItems = [...items, policyRun(2, 10, null, {
      ...replacement.metadata, updatedAt: "2026-04-06T11:01:00Z",
    })];
    const timeout = decideGithubCiDigestFlush(updatedItems, CI_BARRIER_CONFIG, {
      ...context, now: "2026-04-06T11:59:00Z",
    });
    assert.equal(timeout.flush, true, "rechecks must not reset the reconstructed timeout");
    assert.equal(timeout.notificationState?.startedAt, startedAt);
    assert.equal(timeout.notificationState?.generation, 2);
    assert.deepEqual((timeout.notificationState?.runs as Array<Record<string, unknown>>)
      .map((run) => [run.runId, run.attempt]), [[2, attempt]]);
  });
}

test("CI policy can advance SHA cycles created within the same timestamp second", () => {
  const first = decideGithubCiDigestFlush(
    [policyRun(1, 10, "failure"), policyRun(2, 20, "success")], CI_BARRIER_CONFIG, CI_CONTEXT,
  );
  const next = decideGithubCiDigestFlush([
    policyRun(3, 10, "success", { headSha: "sha-next" }), policyRun(4, 20, "success", { headSha: "sha-next" }),
  ], CI_BARRIER_CONFIG, { ...CI_CONTEXT, notificationState: first.notificationState });
  assert.equal(next.flush, true);
  assert.match(next.summary ?? "", /sha-nex.*all expected workflows succeeded/);
});

test("CI provider module exposes policy config and preserves generation metadata without forwarding policy to GitHub", async () => {
  const source: SourceStream = {
    sourceId: "ci-module", sourceType: "github_repo_ci", sourceKey: "holon-run/agentinbox",
    config: CI_BARRIER_CONFIG, configRef: null, status: "active", checkpoint: null,
    createdAt: CI_CONTEXT.threadCreatedAt, updatedAt: CI_CONTEXT.now,
  };
  const module = await new RemoteSourceModuleRegistry().resolve(source, "");
  const capabilities = module.describeCapabilities!(source);
  assert.ok(capabilities.configSchema?.some((field) => field.name === "expectedWorkflowIds"));
  for (const name of ["workflowRunId", "workflowId", "runAttempt", "runCreatedAt", "createdAt", "updatedAt"]) {
    assert.ok(capabilities.metadataFields?.some((field) => field.name === name), name);
  }
  module.validateConfig(source);
  assert.throws(() => module.validateConfig({ ...source, config: { ...CI_BARRIER_CONFIG, expectedWorkflowIds: [10, 10] } }), /expectedWorkflowIds/);
  const spec = module.buildManagedSourceSpec(source);
  assert.ok(spec.args);
  assert.equal(spec.args.expectedWorkflowIds, undefined);
  const mapped = await module.mapRawEvent({
    id: 1, workflow_id: 10, run_attempt: 2, status: "completed", conclusion: "failure",
    head_sha: "sha-current", created_at: CI_CONTEXT.threadCreatedAt,
    updated_at: CI_CONTEXT.now, pull_requests: [{ number: 72 }],
  }, source);
  assert.equal(mapped?.metadata.workflowId, 10);
  assert.equal(mapped?.metadata.runAttempt, 2);
  assert.equal(mapped?.metadata.createdAt, CI_CONTEXT.threadCreatedAt);
  assert.equal(mapped?.metadata.runCreatedAt, CI_CONTEXT.threadCreatedAt);
  assert.equal(mapped?.rawPayload.created_at, CI_CONTEXT.threadCreatedAt);
  const item = ciActivationItem({ metadata: mapped!.metadata });
  const grouping = module.deriveNotificationGrouping!(item, source)!;
  assert.equal(grouping.evaluateOnAppend, true);
  assert.equal(grouping.flushClass, "normal");
  const decision = await module.shouldFlushDigestThread!([item], source, CI_CONTEXT);
  assert.equal(decision?.flush, true);
  assert.match(decision?.summary ?? "", /first failure/);
  const summary = module.summarizeDigestThread!([
    policyRun(1, 10, "success"), policyRun(2, 20, "success"), policyRun(3, 30, "failure"),
  ], source, grouping);
  assert.match(summary ?? "", /2 passed/);
  assert.match(summary ?? "", /1 failed: Workflow 30/);
});

test("CI policy persists first/final/incomplete phases through JSON restart and leaves caller state immutable", () => {
  const failure = policyRun(1, 10, "failure");
  const running = policyRun(2, 20, null);
  const first = decideGithubCiDigestFlush([failure, running], CI_BARRIER_CONFIG, CI_CONTEXT);
  const state = JSON.parse(JSON.stringify(first.notificationState)) as Record<string, unknown>;
  const original = JSON.stringify(state);
  const context = { ...CI_CONTEXT, notificationState: state };
  assert.equal(state.phase, "first");
  assert.ok(state.firstFingerprint);
  assert.equal(decideGithubCiDigestFlush([running, failure, failure], CI_BARRIER_CONFIG, context).flush, false);
  assert.equal(JSON.stringify(state), original);
  const timeout = decideGithubCiDigestFlush([running], CI_BARRIER_CONFIG, { ...context, now: "2026-04-06T11:01:00Z" });
  assert.equal(timeout.notificationState?.phase, "incomplete");
  assert.ok(timeout.notificationState?.incompleteFingerprint);
  assert.match(timeout.summary ?? "", /incomplete.*1 still running/);
  const timeoutContext = { ...context, now: "2026-04-06T11:02:00Z", notificationState: JSON.parse(JSON.stringify(timeout.notificationState)) };
  assert.equal(decideGithubCiDigestFlush([running], CI_BARRIER_CONFIG, timeoutContext).flush, false);
  const final = decideGithubCiDigestFlush([policyRun(2, 20, "success")], CI_BARRIER_CONFIG, timeoutContext);
  assert.equal(final.notificationState?.phase, "final");
  assert.ok(final.notificationState?.finalFingerprint);
  assert.match(final.summary ?? "", /final.*1 failed.*1 passed/);
  assert.equal(decideGithubCiDigestFlush([failure], CI_BARRIER_CONFIG, {
    ...context, notificationState: JSON.parse(JSON.stringify(final.notificationState)),
  }).flush, false);
});

test("CI policy unknown scope still sends first failure, but later terminal events cannot certify success", () => {
  const first = decideGithubCiDigestFlush([policyRun(1, 10, "failure")], CI_DIGEST_CONFIG, CI_CONTEXT);
  assert.equal(first.flush, true);
  const context = { ...CI_CONTEXT, notificationState: first.notificationState };
  assert.equal(decideGithubCiDigestFlush([policyRun(2, 20, "failure")], CI_DIGEST_CONFIG, context).flush, false);
  const timeout = decideGithubCiDigestFlush([policyRun(2, 20, "success")], CI_DIGEST_CONFIG, {
    ...context, now: "2026-04-06T11:01:00Z",
  });
  assert.equal(timeout.flush, true);
  assert.match(timeout.summary ?? "", /incomplete.*expected workflow set unknown/);
  assert.doesNotMatch(timeout.summary ?? "", /all expected workflows succeeded/);
});

test("CI policy waits for terminal conclusions and accepts completion enrichment without regression", () => {
  const unknown = policyRun(1, 10, null, { status: "completed" });
  assert.equal(decideGithubCiDigestFlush([unknown, policyRun(2, 20, "success")], CI_BARRIER_CONFIG, CI_CONTEXT).flush, false);
  const final = decideGithubCiDigestFlush([
    unknown, policyRun(1, 10, "success", { updatedAt: "2026-04-06T10:00:40Z" }),
    policyRun(1, 10, null, { status: "queued", updatedAt: "2026-04-06T10:00:50Z" }),
    policyRun(2, 20, "success"),
  ], CI_BARRIER_CONFIG, CI_CONTEXT);
  assert.equal(final.flush, true);
  assert.match(final.summary ?? "", /all expected workflows succeeded/);
});

test("CI summary ignores history and selects the highest attempt rather than an old failure", () => {
  const summary = summarizeGithubCiDigestThread([
    policyRun(1, 10, "failure", { headSha: "sha-old", createdAt: "2026-04-06T09:00:00Z" }),
    policyRun(2, 10, "failure"),
    policyRun(2, 10, "success", { runAttempt: 2 }),
    policyRun(3, 20, "neutral"),
  ]);
  assert.match(summary ?? "", /sha-cur.*1 passed.*neutral/);
  assert.doesNotMatch(summary ?? "", /sha-old|failed/);
});

test("deriveGithubCiNotificationGrouping groups workflow runs at the pull request level", () => {
  const prGrouping = deriveGithubCiNotificationGrouping(
    ciActivationItem({
      metadata: {
        workflowRunId: 1001,
        repoFullName: "holon-run/agentinbox",
        headSha: "sha-pr-72",
        pullRequestNumbers: [72],
        status: "completed",
        conclusion: "failure",
      },
    }),
    CI_DIGEST_CONFIG,
  );
  assert.ok(prGrouping?.groupable);
  assert.equal(prGrouping?.resourceRef, "pr:holon-run/agentinbox#72");
  assert.equal(prGrouping?.eventFamily, "ci_updates");
  assert.equal(prGrouping?.flushClass, "normal");
  assert.equal(prGrouping?.evaluateOnAppend, true);
  assert.equal(prGrouping?.flushDelayMs, 120_000);

  const successGrouping = deriveGithubCiNotificationGrouping(
    ciActivationItem({
      metadata: {
        workflowRunId: 1002,
        repoFullName: "holon-run/agentinbox",
        headSha: "sha-pr-72",
        pullRequestNumbers: [72],
        status: "queued",
      },
    }),
    CI_DIGEST_CONFIG,
  );
  assert.equal(successGrouping?.flushClass, "normal");

  const pushGrouping = deriveGithubCiNotificationGrouping(
    ciActivationItem({
      metadata: {
        workflowRunId: 1003,
        repoFullName: "holon-run/agentinbox",
        headSha: "sha-main",
        pullRequestNumbers: [],
      },
    }),
    CI_DIGEST_CONFIG,
  );
  assert.equal(pushGrouping?.resourceRef, "push:holon-run/agentinbox:sha-main");
  assert.equal(pushGrouping?.summaryHint, "CI updates for holon-run/agentinbox@sha-mai");

  assert.equal(
    deriveGithubCiNotificationGrouping(ciActivationItem({ metadata: { headSha: "sha-orphan" } }), CI_DIGEST_CONFIG),
    null,
  );
});

test("decideGithubCiDigestFlush waits for terminal runs on the latest head sha and honors the hard timeout", () => {
  const pendingItems = [
    ciActivationItem({
      itemId: "itm_ci_completed",
      occurredAt: "2026-04-06T10:00:00Z",
      metadata: { workflowRunId: 1001, workflowId: 10, headSha: "sha-pr-72", status: "completed", conclusion: "success" },
    }),
    ciActivationItem({
      itemId: "itm_ci_running",
      occurredAt: "2026-04-06T10:00:30Z",
      metadata: { workflowRunId: 1002, workflowId: 20, headSha: "sha-pr-72", status: "in_progress" },
    }),
  ];
  const pendingDecision = decideGithubCiDigestFlush(pendingItems, CI_BARRIER_CONFIG, {
    threadCreatedAt: "2026-04-06T10:00:00Z",
    lastItemAt: "2026-04-06T10:00:30Z",
    now: "2026-04-06T10:01:00Z",
  });
  assert.equal(pendingDecision.flush, false);
  assert.match(pendingDecision.reason ?? "", /1 run\(s\) still pending/);
  assert.equal(pendingDecision.recheckAfterMs, 30_000);

  const terminalDecision = decideGithubCiDigestFlush(
    pendingItems.map((item) =>
      item.itemId === "itm_ci_running"
        ? { ...item, metadata: { ...item.metadata, status: "completed", conclusion: "success" } }
        : item,
    ),
    CI_BARRIER_CONFIG,
    {
      threadCreatedAt: "2026-04-06T10:00:00Z",
      lastItemAt: "2026-04-06T10:00:30Z",
      now: "2026-04-06T10:01:00Z",
    },
  );
  assert.equal(terminalDecision.flush, true);
  assert.match(terminalDecision.reason ?? "", /all expected runs terminal/);

  const timedOutDecision = decideGithubCiDigestFlush(pendingItems, CI_BARRIER_CONFIG, {
    threadCreatedAt: "2026-04-06T09:00:00Z",
    lastItemAt: "2026-04-06T10:00:30Z",
    now: "2026-04-06T10:10:00Z",
  });
  assert.equal(timedOutDecision.flush, true);
  assert.match(timedOutDecision.reason ?? "", /hard timeout/);
});

test("decideGithubCiDigestFlush keeps a run terminal when later items arrive out of order", () => {
  const items = [
    ciActivationItem({
      itemId: "itm_ci_terminal_first",
      occurredAt: "2026-04-06T10:00:10Z",
      metadata: { workflowRunId: 1001, workflowId: 10, headSha: "sha-pr-72", status: "completed", conclusion: "success" },
    }),
    ciActivationItem({
      itemId: "itm_ci_stale_queued",
      occurredAt: "2026-04-06T10:00:40Z",
      metadata: { workflowRunId: 1001, workflowId: 10, headSha: "sha-pr-72", status: "queued" },
    }),
  ];
  const decision = decideGithubCiDigestFlush(items, { ...CI_DIGEST_CONFIG, expectedWorkflowIds: [10] }, {
    threadCreatedAt: "2026-04-06T10:00:00Z",
    lastItemAt: "2026-04-06T10:00:40Z",
    now: "2026-04-06T10:01:00Z",
  });
  assert.equal(decision.flush, true);
  assert.match(decision.reason ?? "", /all expected runs terminal/);

  const summary = summarizeGithubCiDigestThread(items);
  assert.match(summary ?? "", /1 passed/);
  assert.doesNotMatch(summary ?? "", /still running/);
});

test("summarizeGithubCiDigestThread summarizes workflow run outcomes", () => {
  const summary = summarizeGithubCiDigestThread([
    ciActivationItem({
      metadata: {
        workflowRunId: 1001,
        repoFullName: "holon-run/agentinbox",
        headSha: "sha-pr-72",
        pullRequestNumbers: [72],
        name: "CI",
        status: "completed",
        conclusion: "success",
      },
    }),
    ciActivationItem({
      itemId: "itm_ci_fail",
      occurredAt: "2026-04-06T10:00:30Z",
      metadata: {
        workflowRunId: 1002,
        repoFullName: "holon-run/agentinbox",
        headSha: "sha-pr-72",
        pullRequestNumbers: [72],
        name: "Web E2E",
        status: "completed",
        conclusion: "failure",
      },
    }),
    ciActivationItem({
      itemId: "itm_ci_skip",
      occurredAt: "2026-04-06T10:01:00Z",
      metadata: {
        workflowRunId: 1003,
        repoFullName: "holon-run/agentinbox",
        headSha: "sha-pr-72",
        pullRequestNumbers: [72],
        name: "Docs",
        status: "completed",
        conclusion: "skipped",
      },
    }),
  ]);
  assert.equal(summary, "CI for holon-run/agentinbox#72: 3 workflow runs on sha-pr-, 1 failed: Web E2E (failure), 1 passed, 1 non-success: Docs (skipped)");
});

test("github_repo_ci subscriptions can filter by pull request numbers", async () => {
  const { store, service, dir } = await makeService();
  try {
    const fake = new FakeGithubActionsClient();
    const runtime = new GithubCiSourceRuntime(store, async (input) => service.appendSourceEvent(input), new GithubActionsUxcClient(fake));
    const source: SourceStream = {
      sourceId: "src_ci_pr_filter",
      hostId: "hst_ci_pr_filter",
      streamKind: "ci_runs",
      streamKey: "holon-run/agentinbox",
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
    const agent = service.registerAgent({
      backend: "tmux",
      runtimeKind: "codex",
      runtimeSessionId: "github-ci-pr-filter-thread",
      tmuxPaneId: "%203",
    });
    // These assertions verify raw item metadata for subscription filtering;
    // opt out of the now-default digest aggregation.
    service.updateInboxAggregationPolicy(agent.agent.agentId, { enabled: false });
    const subscription = await service.registerSubscription({
      agentId: agent.agent.agentId,
      sourceId: source.sourceId,
      filter: { metadata: { pullRequestNumbers: [72] } },
      startPolicy: "earliest",
    });

    fake.workflowRuns = [
      {
        id: 2001,
        workflow_id: 10,
        name: "CI",
        status: "completed",
        conclusion: "failure",
        event: "pull_request",
        head_sha: "sha-pr-72",
        head_branch: "feature/pr-72",
        updated_at: "2026-04-06T10:01:00Z",
        pull_requests: [{ number: 72 }],
      },
      {
        id: 2002,
        workflow_id: 10,
        name: "CI",
        status: "completed",
        conclusion: "failure",
        event: "pull_request",
        head_sha: "sha-pr-73",
        head_branch: "feature/pr-73",
        updated_at: "2026-04-06T10:02:00Z",
        pull_requests: [{ number: 73 }],
      },
      {
        id: 2003,
        workflow_id: 10,
        name: "Holon Trigger",
        status: "completed",
        conclusion: "success",
        event: "issue_comment",
        head_sha: "sha-main",
        head_branch: "main",
        updated_at: "2026-04-06T10:03:00Z",
      },
    ];

    await runtime.ensureSource(source);
    await runtime.pollSource(source.sourceId);
    const subscriptionResult = await service.pollSubscription(subscription.subscriptionId);
    const items = service.listInboxItems(subscription.agentId);

    assert.equal(subscriptionResult.inboxItemsCreated, 1);
    assert.equal(items.length, 1);
    assert.deepEqual(items[0]?.metadata?.pullRequestNumbers, [72]);
    assert.equal(items[0]?.metadata?.headBranch, "feature/pr-72");
  } finally {
    await service.stop();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("github_repo_ci subscriptions can fall back to head branch and repository when pull request numbers are absent", async () => {
  const { store, service, dir } = await makeService();
  try {
    const fake = new FakeGithubActionsClient();
    const runtime = new GithubCiSourceRuntime(store, async (input) => service.appendSourceEvent(input), new GithubActionsUxcClient(fake));
    const source: SourceStream = {
      sourceId: "src_ci_expr_filter",
      hostId: "hst_ci_expr_filter",
      streamKind: "ci_runs",
      streamKey: "holon-run/agentinbox",
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
    const agent = service.registerAgent({
      backend: "tmux",
      runtimeKind: "codex",
      runtimeSessionId: "github-ci-expr-filter-thread",
      tmuxPaneId: "%204",
    });
    // Raw metadata fallback assertions; opt out of digest aggregation.
    service.updateInboxAggregationPolicy(agent.agent.agentId, { enabled: false });
    const subscription = await service.registerSubscription({
      agentId: agent.agent.agentId,
      sourceId: source.sourceId,
      filter: {
        expr: "contains(metadata.pullRequestNumbers, 72) || (metadata.headBranch == \"feature/pr-72\" && metadata.headRepositoryFullName == \"holon-run/agentinbox\")",
      },
      startPolicy: "earliest",
    });

    fake.workflowRuns = [
      {
        id: 3001,
        workflow_id: 10,
        name: "CI",
        status: "completed",
        conclusion: "failure",
        event: "pull_request",
        head_sha: "sha-pr-72",
        head_branch: "feature/pr-72",
        head_repository: { full_name: "holon-run/agentinbox" },
        updated_at: "2026-04-06T10:01:00Z",
        pull_requests: [],
      },
      {
        id: 3002,
        workflow_id: 10,
        name: "CI",
        status: "completed",
        conclusion: "failure",
        event: "pull_request",
        head_sha: "sha-pr-72-fork",
        head_branch: "feature/pr-72",
        head_repository: { full_name: "someone/fork" },
        updated_at: "2026-04-06T10:02:00Z",
        pull_requests: [],
      },
    ];

    await runtime.ensureSource(source);
    await runtime.pollSource(source.sourceId);
    const subscriptionResult = await service.pollSubscription(subscription.subscriptionId);
    const items = service.listInboxItems(subscription.agentId);

    assert.equal(subscriptionResult.inboxItemsCreated, 1);
    assert.equal(items.length, 1);
    assert.equal(items[0]?.metadata?.headBranch, "feature/pr-72");
    assert.equal(items[0]?.metadata?.headRepositoryFullName, "holon-run/agentinbox");
  } finally {
    await service.stop();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("github_repo_ci source runtime appends workflow run events and subscriptions materialize inbox items", async () => {
  const { store, service, dir } = await makeService();
  try {
    const fake = new FakeGithubActionsClient();
    const runtime = new GithubCiSourceRuntime(store, async (input) => service.appendSourceEvent(input), new GithubActionsUxcClient(fake));
    const source: SourceStream = {
      sourceId: "src_ci",
      hostId: "hst_ci",
      streamKind: "ci_runs",
      streamKey: "holon-run/agentinbox",
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
    const agent = service.registerAgent({
      backend: "tmux",
      runtimeKind: "codex",
      runtimeSessionId: "github-ci-thread",
      tmuxPaneId: "%202",
    });
    // Raw event materialization assertions; opt out of digest aggregation.
    service.updateInboxAggregationPolicy(agent.agent.agentId, { enabled: false });
    const subscription = await service.registerSubscription({
      agentId: agent.agent.agentId,
      sourceId: source.sourceId,
      filter: { metadata: { conclusion: "failure", headBranch: "main" } },
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
    const items = service.listInboxItems(subscription.agentId);

    assert.equal(fake.calls[0]?.operation, "get:/repos/{owner}/{repo}/actions/runs");
    assert.equal(sourceResult.appended, 2);
    assert.equal(subscriptionResult.inboxItemsCreated, 1);
    assert.equal(items.length, 1);
    assert.equal(items[0]?.metadata?.conclusion, "failure");
    assert.equal(items[0]?.eventVariant, "workflow_run.ci.completed.failure");
  } finally {
    await service.stop();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("github_repo_ci runtime start does not crash when GitHub polling fails", async () => {
  const { store, service, dir } = await makeService();
  try {
    const fake = new FakeGithubActionsClient();
    fake.error = new Error("runtime.invoke timeout");
    const runtime = new GithubCiSourceRuntime(store, async (input) => service.appendSourceEvent(input), new GithubActionsUxcClient(fake));
    const source: SourceStream = {
      sourceId: "src_ci_error",
      hostId: "hst_ci_error",
      streamKind: "ci_runs",
      streamKey: "holon-run/agentinbox",
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

    await runtime.start();

    const updatedSource = store.getSource(source.sourceId);
    assert.equal(updatedSource?.status, "error");
    assert.match(String(updatedSource?.checkpoint), /runtime\.invoke timeout/);

    await runtime.stop();
  } finally {
    await service.stop();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("github_repo_ci runtime retries errored sources and recovers after a transient failure", async () => {
  const { store, service, dir } = await makeService();
  let runtime: GithubCiSourceRuntime | null = null;
  try {
    const fake = new FakeGithubActionsClient();
    let callCount = 0;
    fake.listWorkflowRunsImpl = async () => {
      callCount += 1;
      if (callCount === 1) {
        throw new Error("temporary github timeout");
      }
      return [
        {
          id: 1003,
          workflow_id: 10,
          name: "ci",
          display_title: "ci / retry",
          status: "completed",
          conclusion: "success",
          event: "push",
          head_sha: "sha-retry",
          head_branch: "main",
          run_number: 3,
          run_attempt: 1,
          html_url: "https://github.com/holon-run/agentinbox/actions/runs/1003",
          created_at: "2026-04-06T10:02:00Z",
          updated_at: "2026-04-06T10:02:20Z",
          actor: { login: "jolestar" },
        },
      ];
    };
    runtime = new GithubCiSourceRuntime(store, async (input) => service.appendSourceEvent(input), new GithubActionsUxcClient(fake));
    const source: SourceStream = {
      sourceId: "src_ci_retry",
      hostId: "hst_ci_retry",
      streamKind: "ci_runs",
      streamKey: "holon-run/agentinbox",
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

    await runtime.start();
    const errored = store.getSource(source.sourceId);
    assert.equal(errored?.status, "error");
    assert.match(String(errored?.checkpoint), /temporary github timeout/);

    await runtime.pollSource(source.sourceId);
    const recovered = store.getSource(source.sourceId);
    assert.equal(recovered?.status, "active");
    assert.ok(!String(recovered?.checkpoint).includes("temporary github timeout"));
  } finally {
    await runtime?.stop();
    await service.stop();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("github_repo_ci paginates until it reaches the checkpoint boundary", async () => {
  const { store, service, dir } = await makeService();
  try {
    const fake = new FakeGithubActionsClient();
    fake.listWorkflowRunsImpl = async (args) => {
      const page = Number(args.payload && typeof args.payload === "object" ? (args.payload as Record<string, unknown>).page : 1);
      if (page === 1) {
        return [
          {
            id: 4003,
            workflow_id: 10,
            name: "CI",
            status: "completed",
            conclusion: "success",
            event: "push",
            head_sha: "sha-page-1",
            head_branch: "main",
            updated_at: "2026-04-06T10:03:00Z",
          },
          {
            id: 4002,
            workflow_id: 10,
            name: "CI",
            status: "completed",
            conclusion: "success",
            event: "push",
            head_sha: "sha-page-1b",
            head_branch: "main",
            updated_at: "2026-04-06T10:02:00Z",
          },
        ];
      }
      if (page === 2) {
        return [
          {
            id: 4001,
            workflow_id: 10,
            name: "CI",
            status: "completed",
            conclusion: "failure",
            event: "pull_request",
            head_sha: "sha-target",
            head_branch: "feature/pr-72",
            head_repository: { full_name: "holon-run/agentinbox" },
            updated_at: "2026-04-06T10:01:00Z",
            pull_requests: [],
          },
        ];
      }
      return [];
    };
    const runtime = new GithubCiSourceRuntime(store, async (input) => service.appendSourceEvent(input), new GithubActionsUxcClient(fake));
    const source: SourceStream = {
      sourceId: "src_ci_paginated",
      hostId: "hst_ci_paginated",
      streamKind: "ci_runs",
      streamKey: "holon-run/agentinbox",
      sourceType: "github_repo_ci",
      sourceKey: "holon-run/agentinbox",
      configRef: null,
      config: { owner: "holon-run", repo: "agentinbox", uxcAuth: "github-default", perPage: 2 },
      status: "active",
      checkpoint: null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    store.insertSource(source);

    await runtime.ensureSource(source);
    const firstPoll = await runtime.pollSource(source.sourceId);
    assert.equal(firstPoll.appended, 3);
    assert.equal(firstPoll.eventsRead, 3);
    assert.equal(fake.calls.length, 2);

    const secondPoll = await runtime.pollSource(source.sourceId);
    assert.equal(secondPoll.appended, 0);
    assert.equal(secondPoll.eventsRead, 2);
    assert.equal(fake.calls.length, 3);
  } finally {
    await service.stop();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
