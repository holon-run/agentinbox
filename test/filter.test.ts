import test from "node:test";
import assert from "node:assert/strict";
import { matchSubscriptionFilter } from "../src/filter";

const baseContext = {
  metadata: {
    status: "completed",
    conclusion: "failure",
    headBranch: "release/v1",
    mentions: ["alpha"],
    nested: {
      value: "metadata-nested",
    },
  },
  payload: {
    event: "pull_request",
    sender: {
      login: "octocat",
    },
    head_commit: {
      message: "ship [notify-agent]",
    },
  },
  eventVariant: "workflow_run.ci.completed.failure",
  sourceType: "github_repo_ci",
  sourceKey: "holon-run/agentinbox",
} as const;

test("filter shortcuts match metadata and payload namespaces independently", async () => {
  const result = await matchSubscriptionFilter({
    metadata: {
      status: "completed",
      nested: {
        value: "metadata-nested",
      },
    },
    payload: {
      sender: {
        login: "octocat",
      },
    },
  }, baseContext);

  assert.equal(result.matched, true);
});

test("filter shortcuts support dotted payload access", async () => {
  const result = await matchSubscriptionFilter({
    payload: {
      "sender.login": "octocat",
      "head_commit.message": "ship [notify-agent]",
    },
  }, baseContext);

  assert.equal(result.matched, true);
});

test("filter expr supports helper functions and boolean composition", async () => {
  const result = await matchSubscriptionFilter({
    expr: [
      "metadata.status == 'completed'",
      "metadata.conclusion == 'failure'",
      "contains(['CI', 'Nightly'], 'CI')",
      "startsWith(metadata.headBranch, 'release/')",
      "endsWith(sourceKey, 'agentinbox')",
      "matches(payload.sender.login, '^octo')",
      "glob(metadata.headBranch, 'release/*')",
      "exists(payload.head_commit.message)",
      "contains(payload.head_commit.message, '[notify-agent]')",
      "join(metadata.mentions, ',') == 'alpha'",
      "format('{0}:{1}', sourceType, eventVariant) == 'github_repo_ci:workflow_run.ci.completed.failure'",
    ].join(" && "),
  }, baseContext);

  assert.equal(result.matched, true);
});

test("filter expr returns false when expression is false", async () => {
  const result = await matchSubscriptionFilter({
    expr: "payload.sender.login == 'jolestar'",
  }, baseContext);

  assert.equal(result.matched, false);
  assert.match(result.reason, /expr returned false/);
});

test("filter expr returns mismatch when expression is invalid", async () => {
  const result = await matchSubscriptionFilter({
    expr: "payload.sender.login ==",
  }, baseContext);

  assert.equal(result.matched, false);
  assert.match(result.reason, /expr evaluation failed/);
});
