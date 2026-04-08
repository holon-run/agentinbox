import test from "node:test";
import assert from "node:assert/strict";
import { getSourceSchema } from "../src/source_schema";

test("getSourceSchema exposes github repo ci metadata and examples", () => {
  const schema = getSourceSchema("github_repo_ci");

  assert.equal(schema.sourceType, "github_repo_ci");
  assert.ok(schema.metadataFields.some((field) => field.name === "conclusion"));
  assert.ok(schema.eventVariantExamples.includes("workflow_run.ci.completed.failure"));
  assert.ok(schema.payloadExamples[0]?.head_commit);
  assert.ok(schema.configFields.some((field) => field.name === "branch"));
});

test("getSourceSchema exposes lightweight schemas for custom and fixture sources", () => {
  assert.equal(getSourceSchema("custom").sourceType, "custom");
  assert.equal(getSourceSchema("fixture").sourceType, "fixture");
});
