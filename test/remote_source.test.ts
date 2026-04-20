import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { AdapterRegistry } from "../src/adapters";
import { AppendSourceEventInput } from "../src/model";
import { AgentInboxService } from "../src/service";
import { resolveSourceIdentity } from "../src/source_resolution";
import { RemoteSourceRuntime, UxcRemoteSourceClient } from "../src/sources/remote";
import { ManagedSourceSpec, RemoteSourceModuleRegistry, builtInModuleIdForSourceType, moduleConfigForSource } from "../src/sources/remote_modules";
import { AgentInboxStore } from "../src/store";
import { TerminalDispatcher } from "../src/terminal";
import { nowIso } from "../src/util";

class FakeRemoteSourceClient implements UxcRemoteSourceClient {
  private readonly streams = new Map<string, Array<{ offset: number; raw_payload: unknown }>>();
  private readonly offsets = new Map<string, number>();
  private readonly streamSpecs = new Map<string, ManagedSourceSpec>();
  private readonly streamCheckpointKeys = new Map<string, string[]>();
  private readonly managedStatuses = new Map<string, {
    namespace: string;
    source_key: string;
    run_id: string;
    stream_id: string;
    status: string;
    updated_at_unix: number;
    started_at_unix?: number | null;
    stopped_at_unix?: number | null;
    last_error?: string | null;
  }>();
  public readonly ensuredSources: Array<{ namespace: string; sourceKey: string }> = [];
  public readonly stoppedSources: Array<{ namespace: string; sourceKey: string }> = [];
  public readonly deletedSources: Array<{ namespace: string; sourceKey: string }> = [];

  push(streamId: string, payload: unknown): void {
    if (!this.shouldAppend(streamId, payload)) {
      return;
    }
    const currentOffset = this.offsets.get(streamId) ?? 0;
    this.offsets.set(streamId, currentOffset + 1);
    const bucket = this.streams.get(streamId) ?? [];
    bucket.push({
      offset: currentOffset + 1,
      raw_payload: payload,
    });
    this.streams.set(streamId, bucket);
  }

  async sourceEnsure(args: { namespace: string; sourceKey: string; spec: ManagedSourceSpec }): Promise<{
    namespace: string;
    source_key: string;
    run_id: string;
    stream_id: string;
    status: string;
    reused: boolean;
    replaced_previous: boolean;
  }> {
    this.ensuredSources.push({ namespace: args.namespace, sourceKey: args.sourceKey });
    const streamId = `stream:${args.sourceKey}`;
    this.streamSpecs.set(streamId, args.spec);
    const ensured = {
      namespace: args.namespace,
      source_key: args.sourceKey,
      run_id: `run:${args.sourceKey}`,
      stream_id: streamId,
      status: "running",
      reused: true,
      replaced_previous: false,
    };
    this.managedStatuses.set(`${args.namespace}:${args.sourceKey}`, {
      ...ensured,
      updated_at_unix: Math.floor(Date.now() / 1000),
      started_at_unix: Math.floor(Date.now() / 1000),
      stopped_at_unix: null,
      last_error: null,
    });
    return ensured;
  }

  async sourceStop(namespace: string, sourceKey: string): Promise<void> {
    this.stoppedSources.push({ namespace, sourceKey });
    const current = this.managedStatuses.get(`${namespace}:${sourceKey}`);
    if (current) {
      this.managedStatuses.set(`${namespace}:${sourceKey}`, {
        ...current,
        status: "stopped",
        updated_at_unix: Math.floor(Date.now() / 1000),
        stopped_at_unix: Math.floor(Date.now() / 1000),
        last_error: null,
      });
    }
    return;
  }

  async sourceDelete(namespace: string, sourceKey: string): Promise<void> {
    this.deletedSources.push({ namespace, sourceKey });
    this.managedStatuses.delete(`${namespace}:${sourceKey}`);
    return;
  }

  async sourceStatus(namespace: string, sourceKey: string): Promise<{
    namespace: string;
    source_key: string;
    run_id: string;
    stream_id: string;
    spec_key: string;
    status: string;
    created_at_unix: number;
    updated_at_unix: number;
    started_at_unix?: number | null;
    stopped_at_unix?: number | null;
    last_error?: string | null;
  }> {
    const current = this.managedStatuses.get(`${namespace}:${sourceKey}`);
    if (!current) {
      throw new Error(`unknown managed source: ${namespace}/${sourceKey}`);
    }
    return {
      ...current,
      spec_key: `${namespace}:${sourceKey}`,
      created_at_unix: current.started_at_unix ?? current.updated_at_unix,
    };
  }

  async sourceList(): Promise<Array<{
    namespace: string;
    source_key: string;
    status: string;
    run_id: string;
    stream_id: string;
    updated_at_unix: number;
    last_error?: string | null;
  }>> {
    return Array.from(this.managedStatuses.values()).map((current) => ({
      namespace: current.namespace,
      source_key: current.source_key,
      status: current.status,
      run_id: current.run_id,
      stream_id: current.stream_id,
      updated_at_unix: current.updated_at_unix,
      last_error: current.last_error ?? null,
    }));
  }

  async streamRead(args: { streamId: string; afterOffset?: number; limit?: number }): Promise<{
    stream_id: string;
    events: Array<{ stream_id: string; offset: number; ingested_at_unix: number; raw_payload: unknown }>;
    next_after_offset: number;
    has_more: boolean;
  }> {
    const afterOffset = args.afterOffset ?? 0;
    const all = this.streams.get(args.streamId) ?? [];
    const events = all.filter((event) => event.offset > afterOffset).slice(0, args.limit ?? 100);
    const nextAfterOffset = events.length > 0 ? events[events.length - 1]!.offset : afterOffset;
    return {
      stream_id: args.streamId,
      events: events.map((event) => ({
        stream_id: args.streamId,
        offset: event.offset,
        ingested_at_unix: Date.now(),
        raw_payload: event.raw_payload,
      })),
      next_after_offset: nextAfterOffset,
      has_more: false,
    };
  }

  private shouldAppend(streamId: string, payload: unknown): boolean {
    const checkpointStrategy = this.streamSpecs.get(streamId)?.poll_config?.checkpoint_strategy;
    if (!checkpointStrategy || checkpointStrategy.type === "cursor_only") {
      return true;
    }

    const key = checkpointKeyForPayload(payload, checkpointStrategy);
    if (!key) {
      return true;
    }

    const keys = this.streamCheckpointKeys.get(streamId) ?? [];
    if (keys.includes(key)) {
      return false;
    }

    keys.push(key);
    const seenWindow = checkpointStrategy.seen_window ?? 1024;
    if (keys.length > seenWindow) {
      keys.splice(0, keys.length - seenWindow);
    }
    this.streamCheckpointKeys.set(streamId, keys);
    return true;
  }
}

async function makeService(fake: FakeRemoteSourceClient): Promise<{
  dir: string;
  store: AgentInboxStore;
  service: AgentInboxService;
  adapters: AdapterRegistry;
}> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentinbox-remote-source-test-"));
  const store = await AgentInboxStore.open(path.join(dir, "agentinbox.sqlite"));
  let service: AgentInboxService;
  const adapters = new AdapterRegistry(store, async (input: AppendSourceEventInput) => service.appendSourceEvent(input), {
    homeDir: dir,
    remoteSourceClient: fake,
  });
  service = new AgentInboxService(store, adapters, undefined, undefined, undefined, new TerminalDispatcher(async () => ({
    stdout: "",
    stderr: "",
  })));
  return { dir, store, service, adapters };
}

test("remote_source with local module ingests stream events", async () => {
  const fake = new FakeRemoteSourceClient();
  const { dir, store, service } = await makeService(fake);
  try {
    const moduleDir = path.join(dir, "source-modules");
    fs.mkdirSync(moduleDir, { recursive: true });
    fs.writeFileSync(
      path.join(moduleDir, "demo.mjs"),
      `export default {
  id: "demo.remote",
  validateConfig(source) {
    if (!source.config?.tenant) throw new Error("tenant required");
  },
  buildManagedSourceSpec(source) {
    return {
      endpoint: "https://example.com",
      mode: "poll",
      args: { tenant: source.config.tenant },
      poll_config: {
        interval_secs: 30,
        extract_items_pointer: "",
        checkpoint_strategy: { type: "item_key", item_key_pointer: "/id", seen_window: 32 }
      }
    };
  },
  mapRawEvent(raw) {
    if (!raw.id) return null;
    return {
      sourceNativeId: "demo:" + raw.id,
      eventVariant: "demo.created",
      metadata: { tenant: raw.tenant },
      rawPayload: raw
    };
  }
};`,
      "utf8",
    );

    const source = await service.registerSource({
      sourceType: "remote_source",
      sourceKey: "demo-key",
      config: {
        modulePath: "demo.mjs",
        moduleConfig: { tenant: "team-a" },
      },
    });
    const agent = service.registerAgent({
      backend: "tmux",
      runtimeKind: "codex",
      runtimeSessionId: "remote-source-thread",
      tmuxPaneId: "%900",
    });
    const subscription = await service.registerSubscription({
      agentId: agent.agent.agentId,
      sourceId: source.sourceId,
      startPolicy: "earliest",
    });
    fake.push("stream:remote_source:demo-key", { id: "evt-1", tenant: "team-a", text: "hello" });

    const sourcePoll = await service.pollSource(source.sourceId);
    const subscriptionPoll = await service.pollSubscription(subscription.subscriptionId);
    const items = service.listInboxItems(agent.agent.agentId);

    assert.equal(sourcePoll.appended, 1);
    assert.equal(subscriptionPoll.inboxItemsCreated, 1);
    assert.equal(items.length, 1);
    assert.equal(items[0]?.sourceNativeId, "demo:evt-1");
    assert.equal(items[0]?.metadata?.tenant, "team-a");
  } finally {
    await service.stop();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("remote_source modulePath must stay under source-modules root", async () => {
  const fake = new FakeRemoteSourceClient();
  const { dir, store, service } = await makeService(fake);
  try {
    await assert.rejects(
      service.registerSource({
        sourceType: "remote_source",
        sourceKey: "bad-key",
        config: {
          modulePath: "../outside.mjs",
          moduleConfig: {},
        },
      }),
      /must stay under/,
    );
  } finally {
    await service.stop();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("github_repo source uses remote runtime builtin module mapping", async () => {
  const fake = new FakeRemoteSourceClient();
  const { dir, store, service } = await makeService(fake);
  try {
    const source = await service.registerSource({
      sourceType: "github_repo",
      sourceKey: "holon-run/agentinbox",
      config: { owner: "holon-run", repo: "agentinbox" },
    });
    const agent = service.registerAgent({
      backend: "tmux",
      runtimeKind: "codex",
      runtimeSessionId: "remote-github-thread",
      tmuxPaneId: "%901",
    });
    const subscription = await service.registerSubscription({
      agentId: agent.agent.agentId,
      sourceId: source.sourceId,
      filter: { metadata: { mentions: ["alpha"] } },
      startPolicy: "earliest",
    });
    fake.push("stream:github_repo:holon-run/agentinbox", {
      id: "100",
      type: "IssueCommentEvent",
      created_at: "2026-04-04T11:00:00Z",
      actor: { login: "jolestar" },
      repo: { name: "holon-run/agentinbox" },
      payload: {
        action: "created",
        issue: {
          number: 12,
          title: "hello",
          body: "body",
          labels: [{ name: "agent" }],
          html_url: "https://github.com/holon-run/agentinbox/issues/12",
        },
        comment: { id: 9, body: "ping @alpha" },
      },
    });

    const sourcePoll = await service.pollSource(source.sourceId);
    const subscriptionPoll = await service.pollSubscription(subscription.subscriptionId);
    const items = service.listInboxItems(agent.agent.agentId);

    assert.equal(sourcePoll.appended, 1);
    assert.equal(subscriptionPoll.inboxItemsCreated, 1);
    assert.equal(items.length, 1);
    assert.equal(items[0]?.eventVariant, "IssueCommentEvent.created");
    assert.equal(items[0]?.deliveryHandle?.provider, "github");
  } finally {
    await service.stop();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("github_repo source materializes PullRequestReviewEvent items for PR filters", async () => {
  const fake = new FakeRemoteSourceClient();
  const { dir, store, service } = await makeService(fake);
  try {
    const source = await service.registerSource({
      sourceType: "github_repo",
      sourceKey: "holon-run/agentinbox",
      config: { owner: "holon-run", repo: "agentinbox" },
    });
    const agent = service.registerAgent({
      backend: "tmux",
      runtimeKind: "codex",
      runtimeSessionId: "remote-github-review-thread",
      tmuxPaneId: "%903",
    });
    const subscription = await service.registerSubscription({
      agentId: agent.agent.agentId,
      sourceId: source.sourceId,
      filter: { metadata: { number: 67, isPullRequest: true } },
      startPolicy: "earliest",
    });
    fake.push("stream:github_repo:holon-run/agentinbox", {
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

    const sourcePoll = await service.pollSource(source.sourceId);
    const subscriptionPoll = await service.pollSubscription(subscription.subscriptionId);
    const items = service.listInboxItems(agent.agent.agentId);

    assert.equal(sourcePoll.appended, 1);
    assert.equal(subscriptionPoll.inboxItemsCreated, 1);
    assert.equal(items.length, 1);
    assert.equal(items[0]?.eventVariant, "PullRequestReviewEvent.created");
    assert.equal(items[0]?.metadata?.number, 67);
    assert.equal(items[0]?.metadata?.isPullRequest, true);
    assert.equal(items[0]?.metadata?.reviewState, "commented");
    assert.equal(items[0]?.metadata?.body, "review summary");
  } finally {
    await service.stop();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("github_repo pull request subscriptions retire through the generic lifecycle engine", async () => {
  const fake = new FakeRemoteSourceClient();
  const { dir, store, service } = await makeService(fake);
  try {
    const source = await service.registerSource({
      sourceType: "github_repo",
      sourceKey: "holon-run/agentinbox",
      config: { owner: "holon-run", repo: "agentinbox" },
    });
    const agent = service.registerAgent({
      backend: "tmux",
      runtimeKind: "codex",
      runtimeSessionId: "remote-github-lifecycle-thread",
      tmuxPaneId: "%904",
    });
    const subscription = await service.registerSubscription({
      agentId: agent.agent.agentId,
      sourceId: source.sourceId,
      trackedResourceRef: "repo:holon-run/agentinbox:pr:72",
      cleanupPolicy: { mode: "on_terminal" },
      filter: { metadata: { number: 72, isPullRequest: true } },
      startPolicy: "earliest",
    });
    fake.push("stream:github_repo:holon-run/agentinbox", {
      id: "300",
      type: "PullRequestEvent",
      created_at: "2020-04-14T04:39:12Z",
      actor: { login: "jolestar" },
      repo: { name: "holon-run/agentinbox" },
      payload: {
        action: "closed",
        pull_request: {
          number: 72,
          title: "feat: add cleanup policy lifecycle engine",
          merged: true,
          html_url: "https://github.com/holon-run/agentinbox/pull/72",
        },
      },
    });

    const sourcePoll = await service.pollSource(source.sourceId);
    const subscriptionPoll = await service.pollSubscription(subscription.subscriptionId);
    const items = service.listInboxItems(agent.agent.agentId);
    const retirement = store.getSubscriptionLifecycleRetirement(subscription.subscriptionId);

    assert.equal(sourcePoll.appended, 1);
    assert.equal(subscriptionPoll.inboxItemsCreated, 1);
    assert.equal(items.length, 1);
    assert.equal(items[0]?.eventVariant, "PullRequestEvent.closed");
    assert.equal(items[0]?.metadata?.number, 72);
    assert.ok(retirement);
    assert.equal(retirement?.trackedResourceRef, "repo:holon-run/agentinbox:pr:72");
    assert.equal(retirement?.terminalState, "closed");
    assert.equal(retirement?.terminalResult, "merged");

    const gc = service.gc();
    assert.equal(gc.removedSubscriptions, 1);
    assert.equal(store.getSubscription(subscription.subscriptionId), null);
  } finally {
    await service.stop();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("github_repo_ci builtin module emits status transitions for one workflow run id", async () => {
  const fake = new FakeRemoteSourceClient();
  const { dir, store, service } = await makeService(fake);
  try {
    const source = await service.registerSource({
      sourceType: "github_repo_ci",
      sourceKey: "holon-run/agentinbox",
      config: { owner: "holon-run", repo: "agentinbox" },
    });
    const agent = service.registerAgent({
      backend: "tmux",
      runtimeKind: "codex",
      runtimeSessionId: "remote-github-ci-thread",
      tmuxPaneId: "%902",
    });
    const subscription = await service.registerSubscription({
      agentId: agent.agent.agentId,
      sourceId: source.sourceId,
      startPolicy: "earliest",
    });

    fake.push("stream:github_repo_ci:holon-run/agentinbox", {
      id: 24231721087,
      name: "Node Tests",
      display_title: "Node Tests",
      event: "pull_request",
      head_branch: "feature/issue-50-ci-transition-events",
      html_url: "https://github.com/holon-run/agentinbox/actions/runs/24231721087",
      created_at: "2026-04-10T01:00:00Z",
      updated_at: "2026-04-10T01:00:30Z",
    });

    const firstSourcePoll = await service.pollSource(source.sourceId);
    const firstSubscriptionPoll = await service.pollSubscription(subscription.subscriptionId);

    fake.push("stream:github_repo_ci:holon-run/agentinbox", {
      id: 24231721087,
      name: "Node Tests",
      display_title: "Node Tests",
      status: "completed",
      conclusion: "success",
      event: "pull_request",
      head_branch: "feature/issue-50-ci-transition-events",
      html_url: "https://github.com/holon-run/agentinbox/actions/runs/24231721087",
      created_at: "2026-04-10T01:00:00Z",
      updated_at: "2026-04-10T01:02:00Z",
    });

    const secondSourcePoll = await service.pollSource(source.sourceId);
    const secondSubscriptionPoll = await service.pollSubscription(subscription.subscriptionId);
    const items = service.listInboxItems(agent.agent.agentId);

    assert.equal(firstSourcePoll.appended, 1);
    assert.equal(firstSubscriptionPoll.inboxItemsCreated, 1);
    assert.equal(secondSourcePoll.appended, 1);
    assert.equal(secondSubscriptionPoll.inboxItemsCreated, 1);
    assert.equal(items.length, 2);
    assert.deepEqual(
      items.map((item) => item.eventVariant),
      ["workflow_run.node_tests.observed", "workflow_run.node_tests.completed.success"],
    );
  } finally {
    await service.stop();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("removeSource deletes managed source binding when no subscriptions remain", async () => {
  const fake = new FakeRemoteSourceClient();
  const { dir, store, service } = await makeService(fake);
  try {
    const moduleDir = path.join(dir, "source-modules");
    fs.mkdirSync(moduleDir, { recursive: true });
    fs.writeFileSync(
      path.join(moduleDir, "demo-remove.mjs"),
      `export default {
  id: "demo.remove",
  validateConfig() {},
  buildManagedSourceSpec() {
    return {
      endpoint: "https://example.com",
      mode: "poll",
      poll_config: {
        interval_secs: 30,
        extract_items_pointer: "",
        checkpoint_strategy: { type: "item_key", item_key_pointer: "/id", seen_window: 32 }
      }
    };
  },
  mapRawEvent(raw) {
    if (!raw.id) return null;
    return { sourceNativeId: "demo:" + raw.id, eventVariant: "demo.event", metadata: {}, rawPayload: raw };
  }
};`,
      "utf8",
    );
    const source = await service.registerSource({
      sourceType: "remote_source",
      sourceKey: "remove-key",
      config: {
        modulePath: "demo-remove.mjs",
        moduleConfig: {},
      },
    });
    const removed = await service.removeSource(source.sourceId);
    assert.equal(removed.removed, true);
    assert.equal(store.getSource(source.sourceId), null);
    assert.equal(fake.deletedSources.length, 1);
    assert.equal(fake.deletedSources[0]?.sourceKey, "remote_source:remove-key");
  } finally {
    await service.stop();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("remote_source remove --with-subscriptions stops remote binding and deletes dependent subscriptions", async () => {
  const fake = new FakeRemoteSourceClient();
  const { dir, store, service } = await makeService(fake);
  try {
    const moduleDir = path.join(dir, "source-modules");
    fs.mkdirSync(moduleDir, { recursive: true });
    fs.writeFileSync(
      path.join(moduleDir, "demo-remove-cascade.mjs"),
      `export default {
  id: "demo.remove.cascade",
  validateConfig() {},
  buildManagedSourceSpec() {
    return {
      endpoint: "https://example.com",
      mode: "poll",
      poll_config: {
        interval_secs: 30,
        extract_items_pointer: "",
        checkpoint_strategy: { type: "item_key", item_key_pointer: "/id", seen_window: 32 }
      }
    };
  },
  mapRawEvent(raw) {
    if (!raw.id) return null;
    return { sourceNativeId: "demo:" + raw.id, eventVariant: "demo.event", metadata: {}, rawPayload: raw };
  }
};`,
      "utf8",
    );
    const source = await service.registerSource({
      sourceType: "remote_source",
      sourceKey: "remove-cascade-key",
      config: {
        modulePath: "demo-remove-cascade.mjs",
        moduleConfig: {},
      },
    });
    const agent = service.registerAgent({
      backend: "tmux",
      runtimeKind: "codex",
      runtimeSessionId: "remote-remove-cascade-thread",
      tmuxPaneId: "%905",
    });
    const subscription = await service.registerSubscription({
      agentId: agent.agent.agentId,
      sourceId: source.sourceId,
      startPolicy: "earliest",
    });

    const removed = await service.removeSource(source.sourceId, { withSubscriptions: true });
    assert.equal(removed.removed, true);
    assert.equal(removed.removedSubscriptions, 1);
    assert.equal(removed.pausedSource, true);
    assert.equal(store.getSource(source.sourceId), null);
    assert.equal(store.getSubscription(subscription.subscriptionId), null);
    assert.equal(fake.stoppedSources.length, 1);
    assert.equal(fake.stoppedSources[0]?.sourceKey, "remote_source:remove-cascade-key");
    assert.equal(fake.deletedSources.length, 1);
    assert.equal(fake.deletedSources[0]?.sourceKey, "remote_source:remove-cascade-key");
  } finally {
    await service.stop();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("remote module helpers expose builtin module ids and config projection", async () => {
  const registry = new RemoteSourceModuleRegistry();
  assert.ok(registry instanceof RemoteSourceModuleRegistry);
  assert.equal(builtInModuleIdForSourceType("github_repo"), "builtin.github_repo");
  assert.deepEqual(
    moduleConfigForSource({
      sourceId: "src_demo",
      sourceType: "remote_source",
      sourceKey: "demo-module-config",
      configRef: null,
      config: { moduleConfig: { answer: 42 } },
      status: "active",
      checkpoint: null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    }),
    { answer: 42 },
  );
});

test("user-defined remote_source modules can expose delivery actions and invoke them", async () => {
  const fake = new FakeRemoteSourceClient();
  const { dir, store, service } = await makeService(fake);
  try {
    const moduleDir = path.join(dir, "source-modules");
    fs.mkdirSync(moduleDir, { recursive: true });
    fs.writeFileSync(
      path.join(moduleDir, "delivery-hook.mjs"),
      `globalThis.__deliveryCalls = globalThis.__deliveryCalls ?? [];
export default {
  id: "demo.delivery-hook",
  validateConfig() {},
  buildManagedSourceSpec() {
    return {
      endpoint: "https://example.com",
      mode: "poll",
      poll_config: {
        interval_secs: 30,
        extract_items_pointer: "",
        checkpoint_strategy: { type: "item_key", item_key_pointer: "/id", seen_window: 32 }
      }
    };
  },
  mapRawEvent(raw) {
    return raw?.id ? {
      sourceNativeId: String(raw.id),
      eventVariant: "demo.created",
      metadata: {},
      rawPayload: raw
    } : null;
  },
  listDeliveryOperations() {
    return [{
      name: "ack_remote_event",
      title: "Ack Remote Event",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["body"],
        properties: { body: { type: "string" } }
      }
    }];
  },
  async invokeDeliveryOperation(input) {
    globalThis.__deliveryCalls.push({
      operation: input.operation,
      input: input.input,
      targetRef: input.handle.targetRef
    });
    return { status: "sent", note: "sent custom remote delivery" };
  }
};`,
      "utf8",
    );

    const source = await service.registerSource({
      sourceType: "remote_source",
      sourceKey: "demo-delivery",
      config: {
        modulePath: "delivery-hook.mjs",
        moduleConfig: {},
      },
    });

    const listed = await service.listDeliveryActions({
      sourceId: source.sourceId,
      provider: "demo",
      surface: "ticket",
      targetRef: "ticket:42",
    });
    assert.deepEqual(listed.operations.map((operation) => operation.name), ["ack_remote_event"]);

    const invoked = await service.invokeDelivery({
      sourceId: source.sourceId,
      provider: "demo",
      surface: "ticket",
      targetRef: "ticket:42",
      operation: "ack_remote_event",
      input: { body: "acked" },
    });
    assert.equal(invoked.status, "sent");
    assert.equal(invoked.note, "sent custom remote delivery");

    const calls = ((globalThis as { __deliveryCalls?: Array<Record<string, unknown>> }).__deliveryCalls ?? []);
    assert.deepEqual(calls, [{
      operation: "ack_remote_event",
      input: { body: "acked" },
      targetRef: "ticket:42",
    }]);
  } finally {
    delete (globalThis as { __deliveryCalls?: unknown }).__deliveryCalls;
    await service.stop();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function checkpointKeyForPayload(
  payload: unknown,
  strategy: NonNullable<ManagedSourceSpec["poll_config"]>["checkpoint_strategy"],
): string | null {
  if (strategy.type === "content_hash") {
    return JSON.stringify(payload);
  }
  if (strategy.type === "item_key") {
    const value = readJsonPointer(payload, strategy.item_key_pointer);
    return value == null ? null : serializeCheckpointValue(value);
  }
  if (strategy.type === "watermark") {
    const watermark = readJsonPointer(payload, strategy.item_watermark_pointer);
    if (watermark == null) {
      return null;
    }
    const tiebreaker = strategy.item_tiebreaker_pointer
      ? readJsonPointer(payload, strategy.item_tiebreaker_pointer)
      : null;
    return `${serializeCheckpointValue(watermark)}::${serializeCheckpointValue(tiebreaker)}`;
  }
  return null;
}

function readJsonPointer(value: unknown, pointer: string): unknown {
  if (pointer === "") {
    return value;
  }
  if (!pointer.startsWith("/")) {
    return null;
  }
  let current = value;
  for (const rawSegment of pointer.slice(1).split("/")) {
    const segment = rawSegment.replace(/~1/g, "/").replace(/~0/g, "~");
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return null;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function serializeCheckpointValue(value: unknown): string {
  if (value == null) {
    return "null";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}

test("pauseSource stops managed source, preserves binding, and resume re-ensures it", async () => {
  const fake = new FakeRemoteSourceClient();
  const { dir, store, service, adapters } = await makeService(fake);
  try {
    const moduleDir = path.join(dir, "source-modules");
    fs.mkdirSync(moduleDir, { recursive: true });
    fs.writeFileSync(
      path.join(moduleDir, "demo-pause.mjs"),
      `export default {
  id: "demo.pause",
  validateConfig() {},
  buildManagedSourceSpec() {
    return {
      endpoint: "https://example.com",
      mode: "poll",
      poll_config: {
        interval_secs: 30,
        extract_items_pointer: "",
        checkpoint_strategy: { type: "item_key", item_key_pointer: "/id", seen_window: 32 }
      }
    };
  },
  mapRawEvent(raw) {
    if (!raw.id) return null;
    return { sourceNativeId: "demo:" + raw.id, eventVariant: "demo.event", metadata: {}, rawPayload: raw };
  }
};`,
      "utf8",
    );

    const source = await service.registerSource({
      sourceType: "remote_source",
      sourceKey: "pause-key",
      config: {
        modulePath: "demo-pause.mjs",
        moduleConfig: {},
      },
    });
    const initialEnsureCount = fake.ensuredSources.length;
    assert.equal(initialEnsureCount, 1);

    store.updateSourceRuntime(source.sourceId, {
      checkpoint: JSON.stringify({
        managedSource: {
          namespace: "custom-agentinbox",
          sourceKey: "custom:pause-key",
          streamId: "stream:custom:pause-key",
        },
      }),
    });

    const remoteRuntime = (adapters as unknown as {
      remoteSource: {
        errorCounts: Map<string, number>;
        nextRetryAt: Map<string, number>;
      };
    }).remoteSource;
    remoteRuntime.errorCounts.set(source.sourceId, 2);
    remoteRuntime.nextRetryAt.set(source.sourceId, Date.now() + 60_000);

    const paused = await service.pauseSource(source.sourceId);
    assert.equal(paused.paused, true);
    assert.equal(paused.source?.status, "paused");
    assert.deepEqual(fake.stoppedSources, [{
      namespace: "custom-agentinbox",
      sourceKey: "custom:pause-key",
    }]);
    assert.equal(remoteRuntime.errorCounts.has(source.sourceId), false);
    assert.equal(remoteRuntime.nextRetryAt.has(source.sourceId), false);
    assert.deepEqual(((await service.status()).adapters as { remote: { erroredSourceIds: string[] } }).remote.erroredSourceIds, []);

    const pausedPoll = await service.pollSource(source.sourceId);
    assert.equal(pausedPoll.note, "source is paused; resume it before polling");
    assert.equal(fake.ensuredSources.length, initialEnsureCount);

    const resumed = await service.resumeSource(source.sourceId);
    assert.equal(resumed.resumed, true);
    assert.equal(resumed.source?.status, "active");
    assert.equal(fake.ensuredSources.length, initialEnsureCount + 1);
    assert.deepEqual(fake.ensuredSources.at(-1), {
      namespace: "custom-agentinbox",
      sourceKey: "custom:pause-key",
    });
  } finally {
    await service.stop();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("updateSource re-ensures active remote sources but does not resume paused ones", async () => {
  const fake = new FakeRemoteSourceClient();
  const { dir, store, service } = await makeService(fake);
  try {
    const moduleDir = path.join(dir, "source-modules");
    fs.mkdirSync(moduleDir, { recursive: true });
    fs.writeFileSync(
      path.join(moduleDir, "demo-update.mjs"),
      `export default {
  id: "demo.update",
  validateConfig(source) {
    if (!source.config?.tenant) throw new Error("tenant required");
  },
  buildManagedSourceSpec(source) {
    return {
      endpoint: "https://example.com",
      mode: "poll",
      args: { tenant: source.config.tenant },
      poll_config: {
        interval_secs: 30,
        extract_items_pointer: "",
        checkpoint_strategy: { type: "item_key", item_key_pointer: "/id", seen_window: 32 }
      }
    };
  },
  mapRawEvent(raw) {
    if (!raw.id) return null;
    return { sourceNativeId: "demo:" + raw.id, eventVariant: "demo.event", metadata: {}, rawPayload: raw };
  }
};`,
      "utf8",
    );

    const source = await service.registerSource({
      sourceType: "remote_source",
      sourceKey: "update-key",
      config: {
        modulePath: "demo-update.mjs",
        moduleConfig: { tenant: "team-a" },
      },
    });

    assert.equal(fake.ensuredSources.length, 1);

    const updatedActive = await service.updateSource(source.sourceId, {
      config: {
        modulePath: "demo-update.mjs",
        moduleConfig: { tenant: "team-b" },
      },
    });
    assert.equal(updatedActive.updated, true);
    assert.equal(updatedActive.source?.status, "active");
    assert.equal(fake.ensuredSources.length, 2);

    await service.pauseSource(source.sourceId);
    const ensureCountBeforePausedUpdate = fake.ensuredSources.length;
    const updatedPaused = await service.updateSource(source.sourceId, {
      config: {
        modulePath: "demo-update.mjs",
        moduleConfig: { tenant: "team-c" },
      },
    });
    assert.equal(updatedPaused.updated, true);
    assert.equal(updatedPaused.source?.status, "paused");
    assert.equal(fake.ensuredSources.length, ensureCountBeforePausedUpdate);

    await assert.rejects(
      service.updateSource(source.sourceId, {
        config: {
          modulePath: "demo-update.mjs",
          moduleConfig: {},
        },
      }),
      /tenant required/,
    );
    assert.equal(service.getSource(source.sourceId).status, "paused");
    assert.equal(fake.ensuredSources.length, ensureCountBeforePausedUpdate);
  } finally {
    await service.stop();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("idle remote sources auto-pause after the last subscription is removed and resume on new subscription", async () => {
  const fake = new FakeRemoteSourceClient();
  const { dir, store, service } = await makeService(fake);
  try {
    const moduleDir = path.join(dir, "source-modules");
    fs.mkdirSync(moduleDir, { recursive: true });
    fs.writeFileSync(
      path.join(moduleDir, "demo-idle.mjs"),
      `export default {
  id: "demo.idle",
  validateConfig() {},
  buildManagedSourceSpec() {
    return {
      endpoint: "https://example.com",
      mode: "poll",
      poll_config: {
        interval_secs: 30,
        extract_items_pointer: "",
        checkpoint_strategy: { type: "item_key", item_key_pointer: "/id", seen_window: 32 }
      }
    };
  },
  mapRawEvent(raw) {
    if (!raw.id) return null;
    return { sourceNativeId: "demo:" + raw.id, eventVariant: "demo.event", metadata: {}, rawPayload: raw };
  }
};`,
      "utf8",
    );

    const source = await service.registerSource({
      sourceType: "remote_source",
      sourceKey: "idle-key",
      config: {
        modulePath: "demo-idle.mjs",
        moduleConfig: {},
      },
    });
    const agent = service.registerAgent({
      backend: "tmux",
      runtimeKind: "codex",
      runtimeSessionId: "idle-thread",
      tmuxPaneId: "%970",
    });
    const first = await service.registerSubscription({
      agentId: agent.agent.agentId,
      sourceId: source.sourceId,
      startPolicy: "earliest",
    });

    await service.removeSubscription(first.subscriptionId);

    const idleState = store.getSourceIdleState(source.sourceId);
    assert.ok(idleState);
    assert.equal(idleState?.autoPausedAt, null);
    store.upsertSourceIdleState({
      ...idleState!,
      autoPauseAt: "2020-01-01T00:00:00.000Z",
      updatedAt: nowIso(),
    });

    await (service as unknown as { runIdleSourceCleanupPass(nowMs: number): Promise<void> }).runIdleSourceCleanupPass(Date.now());
    assert.equal(service.getSource(source.sourceId).status, "paused");
    assert.equal(fake.stoppedSources.length, 1);
    assert.ok(store.getSourceIdleState(source.sourceId)?.autoPausedAt);

    const ensureCountBeforeResume = fake.ensuredSources.length;
    const second = await service.registerSubscription({
      agentId: agent.agent.agentId,
      sourceId: source.sourceId,
      startPolicy: "earliest",
    });

    assert.equal(service.getSource(source.sourceId).status, "active");
    assert.equal(store.getSourceIdleState(source.sourceId), null);
    assert.equal(fake.ensuredSources.length, ensureCountBeforeResume + 1);
    assert.ok(store.getSubscription(second.subscriptionId));
  } finally {
    await service.stop();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
