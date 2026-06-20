import test from "node:test";
import assert from "node:assert/strict";
import { buildSubscriptionListQuery } from "../src/store_queries";

test("buildSubscriptionListQuery keeps default subscription ordering", () => {
  assert.deepEqual(buildSubscriptionListQuery(), {
    sql: "select * from subscriptions order by created_at asc, subscription_id asc",
    params: [],
  });
});

test("buildSubscriptionListQuery applies filters before limit", () => {
  assert.deepEqual(buildSubscriptionListQuery({ sourceId: "src_1", agentId: "agent_1", limit: 10 }), {
    sql: "select * from subscriptions where source_id = ? and agent_id = ? order by created_at asc, subscription_id asc limit ?",
    params: ["src_1", "agent_1", 10],
  });
});
