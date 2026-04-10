import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { AdapterRegistry } from "../src/adapters";
import { AppendSourceEventInput } from "../src/model";
import { AgentInboxService } from "../src/service";
import { UxcRemoteSourceClient } from "../src/sources/remote";
import { AgentInboxStore } from "../src/store";
import { TerminalDispatcher } from "../src/terminal";

class FakeRemoteSourceClient implements UxcRemoteSourceClient {
  private readonly streams = new Map<string, Array<{ offset: number; raw_payload: unknown }>>();
  private readonly offsets = new Map<string, number>();
  public readonly ensuredSources: Array<{ namespace: string; sourceKey: string }> = [];
  public readonly stoppedSources: Array<{ namespace: string; sourceKey: string }> = [];
  public readonly deletedSources: Array<{ namespace: string; sourceKey: string }> = [];

  push(streamId: string, payload: unknown): void {
    const currentOffset = this.offsets.get(streamId) ?? 0;
    this.offsets.set(streamId, currentOffset + 1);
    const bucket = this.streams.get(streamId) ?? [];
    bucket.push({
      offset: currentOffset + 1,
      raw_payload: payload,
    });
    this.streams.set(streamId, bucket);
  }

  async sourceEnsure(args: { namespace: string; sourceKey: string; spec: unknown }): Promise<{
    namespace: string;
    source_key: string;
    run_id: string;
    stream_id: string;
    status: string;
    reused: boolean;
    replaced_previous: boolean;
  }> {
    void args.spec;
    this.ensuredSources.push({ namespace: args.namespace, sourceKey: args.sourceKey });
    const streamId = `stream:${args.sourceKey}`;
    return {
      namespace: args.namespace,
      source_key: args.sourceKey,
      run_id: `run:${args.sourceKey}`,
      stream_id: streamId,
      status: "running",
      reused: true,
      replaced_previous: false,
    };
  }

  async sourceStop(namespace: string, sourceKey: string): Promise<void> {
    this.stoppedSources.push({ namespace, sourceKey });
    return;
  }

  async sourceDelete(namespace: string, sourceKey: string): Promise<void> {
    this.deletedSources.push({ namespace, sourceKey });
    return;
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

test("remote_source with local profile ingests stream events", async () => {
  const fake = new FakeRemoteSourceClient();
  const { dir, store, service } = await makeService(fake);
  try {
    const profileDir = path.join(dir, "source-profiles");
    fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(
      path.join(profileDir, "demo.mjs"),
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
        profilePath: "demo.mjs",
        profileConfig: { tenant: "team-a" },
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

test("remote_source profilePath must stay under source-profiles root", async () => {
  const fake = new FakeRemoteSourceClient();
  const { dir, store, service } = await makeService(fake);
  try {
    await assert.rejects(
      service.registerSource({
        sourceType: "remote_source",
        sourceKey: "bad-key",
        config: {
          profilePath: "../outside.mjs",
          profileConfig: {},
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

test("github_repo source uses remote runtime builtin profile mapping", async () => {
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

test("removeSource deletes managed source binding when no subscriptions remain", async () => {
  const fake = new FakeRemoteSourceClient();
  const { dir, store, service } = await makeService(fake);
  try {
    const profileDir = path.join(dir, "source-profiles");
    fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(
      path.join(profileDir, "demo-remove.mjs"),
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
        profilePath: "demo-remove.mjs",
        profileConfig: {},
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

test("pauseSource stops managed source, preserves binding, and resume re-ensures it", async () => {
  const fake = new FakeRemoteSourceClient();
  const { dir, store, service, adapters } = await makeService(fake);
  try {
    const profileDir = path.join(dir, "source-profiles");
    fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(
      path.join(profileDir, "demo-pause.mjs"),
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
        profilePath: "demo-pause.mjs",
        profileConfig: {},
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
    assert.deepEqual((service.status().adapters as { remote: { erroredSourceIds: string[] } }).remote.erroredSourceIds, []);

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
    const profileDir = path.join(dir, "source-profiles");
    fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(
      path.join(profileDir, "demo-update.mjs"),
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
        profilePath: "demo-update.mjs",
        profileConfig: { tenant: "team-a" },
      },
    });

    assert.equal(fake.ensuredSources.length, 1);

    const updatedActive = await service.updateSource(source.sourceId, {
      config: {
        profilePath: "demo-update.mjs",
        profileConfig: { tenant: "team-b" },
      },
    });
    assert.equal(updatedActive.updated, true);
    assert.equal(updatedActive.source?.status, "active");
    assert.equal(fake.ensuredSources.length, 2);

    await service.pauseSource(source.sourceId);
    const ensureCountBeforePausedUpdate = fake.ensuredSources.length;
    const updatedPaused = await service.updateSource(source.sourceId, {
      config: {
        profilePath: "demo-update.mjs",
        profileConfig: { tenant: "team-c" },
      },
    });
    assert.equal(updatedPaused.updated, true);
    assert.equal(updatedPaused.source?.status, "paused");
    assert.equal(fake.ensuredSources.length, ensureCountBeforePausedUpdate);
  } finally {
    await service.stop();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
