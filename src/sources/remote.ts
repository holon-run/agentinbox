import { ManagedSourceEnsureResponse, ManagedStreamReadResponse, UxcDaemonClient } from "@holon-run/uxc-daemon-client";
import { ActivationItem, AppendSourceEventInput, SourcePollResult, SubscriptionSource } from "../model";
import { resolveAgentInboxHome } from "../paths";
import { AgentInboxStore } from "../store";
import { nowIso } from "../util";
import { ExpandedSubscriptionInput, LifecycleSignal, ManagedSourceSpec, RemoteSourceProfileRegistry } from "./remote_profiles";

const REMOTE_SOURCE_TYPES = new Set<SubscriptionSource["sourceType"]>([
  "remote_source",
  "github_repo",
  "github_repo_ci",
  "feishu_bot",
]);

const DEFAULT_SYNC_INTERVAL_MS = 2_000;
const DEFAULT_BACKOFF_BASE_SECS = 2;
const MAX_ERROR_BACKOFF_MULTIPLIER = 8;
const MANAGED_SOURCE_NAMESPACE = "agentinbox";

interface RemoteSourceCheckpoint {
  managedSource?: {
    namespace: string;
    sourceKey: string;
    streamId: string;
  };
  streamCursor?: {
    afterOffset: number;
  };
  lastEventAt?: string;
  lastError?: string | null;
}

export interface UxcRemoteSourceClient {
  sourceEnsure(args: {
    namespace: string;
    sourceKey: string;
    spec: ManagedSourceSpec;
  }): Promise<ManagedSourceEnsureResponse>;
  sourceStop(namespace: string, sourceKey: string): Promise<void>;
  sourceDelete(namespace: string, sourceKey: string): Promise<void>;
  streamRead(args: {
    streamId: string;
    afterOffset?: number;
    limit?: number;
  }): Promise<ManagedStreamReadResponse>;
}

export class RpcUxcRemoteSourceClient implements UxcRemoteSourceClient {
  constructor(private readonly client: UxcDaemonClient = new UxcDaemonClient({ env: process.env })) {}

  sourceEnsure(args: { namespace: string; sourceKey: string; spec: ManagedSourceSpec }): Promise<ManagedSourceEnsureResponse> {
    return this.client.sourceEnsure({
      namespace: args.namespace,
      sourceKey: args.sourceKey,
      spec: {
        ...args.spec,
        operation_id: args.spec.operation_id ?? null,
        resource_uri: args.spec.resource_uri ?? null,
        read_resource: args.spec.read_resource ?? false,
        transport_hint: args.spec.transport_hint ?? null,
        subprotocols: args.spec.subprotocols ?? [],
        initial_text_frames: args.spec.initial_text_frames ?? [],
        poll_config: args.spec.poll_config ?? null,
        options: args.spec.options,
      },
    });
  }

  async sourceStop(namespace: string, sourceKey: string): Promise<void> {
    await this.client.sourceStop(namespace, sourceKey);
  }

  async sourceDelete(namespace: string, sourceKey: string): Promise<void> {
    await this.client.sourceDelete(namespace, sourceKey);
  }

  streamRead(args: { streamId: string; afterOffset?: number; limit?: number }): Promise<ManagedStreamReadResponse> {
    return this.client.streamRead({
      streamId: args.streamId,
      afterOffset: args.afterOffset ?? 0,
      limit: args.limit ?? 100,
    });
  }
}

export class RemoteSourceRuntime {
  private readonly profileRegistry: RemoteSourceProfileRegistry;
  private readonly client: UxcRemoteSourceClient;
  private interval: NodeJS.Timeout | null = null;
  private readonly inFlight = new Set<string>();
  private readonly errorCounts = new Map<string, number>();
  private readonly nextRetryAt = new Map<string, number>();
  private readonly homeDir: string;

  constructor(
    private readonly store: AgentInboxStore,
    private readonly appendSourceEvent: (input: AppendSourceEventInput) => Promise<{ appended: number; deduped: number }>,
    options?: {
      profileRegistry?: RemoteSourceProfileRegistry;
      client?: UxcRemoteSourceClient;
      homeDir?: string;
    },
  ) {
    this.profileRegistry = options?.profileRegistry ?? new RemoteSourceProfileRegistry();
    this.client = options?.client ?? new RpcUxcRemoteSourceClient();
    this.homeDir = options?.homeDir ?? resolveAgentInboxHome(process.env);
  }

  async ensureSource(source: SubscriptionSource): Promise<void> {
    if (!REMOTE_SOURCE_TYPES.has(source.sourceType)) {
      return;
    }
    await this.syncSource(source.sourceId, true);
  }

  async validateSource(source: SubscriptionSource): Promise<void> {
    if (!REMOTE_SOURCE_TYPES.has(source.sourceType)) {
      return;
    }
    const profile = await this.profileRegistry.resolve(source, this.homeDir);
    const profileSource = profileInputSource(source);
    profile.validateConfig(profileSource);
    profile.buildManagedSourceSpec(profileSource);
  }

  async start(): Promise<void> {
    if (this.interval) {
      return;
    }
    this.interval = setInterval(() => {
      void this.syncAll();
    }, DEFAULT_SYNC_INTERVAL_MS);
    try {
      await this.syncAll();
    } catch (error) {
      console.warn("remote_source initial sync failed:", error);
    }
  }

  async stop(): Promise<void> {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  async pollSource(sourceId: string): Promise<SourcePollResult> {
    const source = this.store.getSource(sourceId);
    if (!source) {
      throw new Error(`unknown source: ${sourceId}`);
    }
    if (source.status === "paused") {
      return {
        sourceId,
        sourceType: source.sourceType,
        appended: 0,
        deduped: 0,
        eventsRead: 0,
        note: "source is paused; resume it before polling",
      };
    }
    return this.syncSource(sourceId, true);
  }

  async pauseSource(sourceId: string): Promise<void> {
    const source = this.store.getSource(sourceId);
    if (!source || !REMOTE_SOURCE_TYPES.has(source.sourceType)) {
      return;
    }
    const binding = managedBindingForSource(source);
    await this.client.sourceStop(binding.namespace, binding.sourceKey);
    this.errorCounts.delete(sourceId);
    this.nextRetryAt.delete(sourceId);
    const checkpoint = parseRemoteCheckpoint(source.checkpoint);
    this.store.updateSourceRuntime(sourceId, {
      status: "paused",
      checkpoint: JSON.stringify({
        ...checkpoint,
        ...(checkpoint.managedSource ? {
          managedSource: {
            namespace: binding.namespace,
            sourceKey: binding.sourceKey,
            streamId: checkpoint.managedSource.streamId,
          },
        } : {}),
        lastError: null,
      } satisfies RemoteSourceCheckpoint),
    });
  }

  async resumeSource(sourceId: string): Promise<void> {
    const source = this.store.getSource(sourceId);
    if (!source || !REMOTE_SOURCE_TYPES.has(source.sourceType)) {
      return;
    }
    await this.syncSource(sourceId, true);
  }

  async removeSource(sourceId: string): Promise<void> {
    const source = this.store.getSource(sourceId);
    if (!source || !REMOTE_SOURCE_TYPES.has(source.sourceType)) {
      return;
    }
    const binding = managedBindingForSource(source);
    await this.client.sourceDelete(binding.namespace, binding.sourceKey);
  }

  status(): Record<string, unknown> {
    return {
      activeSourceIds: Array.from(this.inFlight.values()).sort(),
      erroredSourceIds: Array.from(this.errorCounts.keys()).sort(),
    };
  }

  async projectLifecycleSignal(source: SubscriptionSource, rawPayload: Record<string, unknown>): Promise<LifecycleSignal | null> {
    if (!REMOTE_SOURCE_TYPES.has(source.sourceType)) {
      return null;
    }
    const profile = await this.profileRegistry.resolve(source, this.homeDir);
    if (typeof profile.projectLifecycleSignal !== "function") {
      return null;
    }
    return profile.projectLifecycleSignal(rawPayload, profileInputSource(source));
  }

  async expandSubscriptionShortcut(
    source: SubscriptionSource,
    input: { name: string; args?: Record<string, unknown> },
  ): Promise<ExpandedSubscriptionInput | null> {
    if (!REMOTE_SOURCE_TYPES.has(source.sourceType)) {
      return null;
    }
    const profile = await this.profileRegistry.resolve(source, this.homeDir);
    if (typeof profile.expandSubscriptionShortcut !== "function") {
      return null;
    }
    return profile.expandSubscriptionShortcut({
      name: input.name,
      args: input.args,
      source: profileInputSource(source),
    });
  }

  async deriveInlinePreview(source: SubscriptionSource, item: ActivationItem): Promise<string | null> {
    if (!REMOTE_SOURCE_TYPES.has(source.sourceType)) {
      return null;
    }
    const profile = await this.profileRegistry.resolve(source, this.homeDir);
    if (typeof profile.deriveInlinePreview !== "function") {
      return null;
    }
    return profile.deriveInlinePreview(item, profileInputSource(source));
  }

  private async syncAll(): Promise<void> {
    const sources = this.store
      .listSources()
      .filter((source) => REMOTE_SOURCE_TYPES.has(source.sourceType) && source.status !== "paused");
    for (const source of sources) {
      try {
        await this.syncSource(source.sourceId, false);
      } catch (error) {
        console.warn(`remote source sync failed for ${source.sourceId}:`, error);
      }
    }
  }

  private async syncSource(sourceId: string, force: boolean): Promise<SourcePollResult> {
    if (this.inFlight.has(sourceId)) {
      const source = this.store.getSource(sourceId);
      return {
        sourceId,
        sourceType: source?.sourceType ?? "remote_source",
        appended: 0,
        deduped: 0,
        eventsRead: 0,
        note: "source sync already in flight",
      };
    }
    this.inFlight.add(sourceId);
    try {
      const source = this.store.getSource(sourceId);
      if (!source) {
        throw new Error(`unknown source: ${sourceId}`);
      }
      if (!REMOTE_SOURCE_TYPES.has(source.sourceType)) {
        return {
          sourceId,
          sourceType: source.sourceType,
          appended: 0,
          deduped: 0,
          eventsRead: 0,
          note: "source type is not hosted by remote runtime",
        };
      }
      if (!force && source.status === "error") {
        const retryAt = this.nextRetryAt.get(sourceId) ?? 0;
        if (Date.now() < retryAt) {
          return {
            sourceId,
            sourceType: source.sourceType,
            appended: 0,
            deduped: 0,
            eventsRead: 0,
            note: "error backoff not elapsed",
          };
        }
      }

      const profile = await this.profileRegistry.resolve(source, this.homeDir);
      const profileSource = profileInputSource(source);
      profile.validateConfig(profileSource);
      const spec = profile.buildManagedSourceSpec(profileSource);
      const binding = managedBindingForSource(source);
      const ensured = await this.client.sourceEnsure({
        namespace: binding.namespace,
        sourceKey: binding.sourceKey,
        spec,
      });

      const checkpoint = parseRemoteCheckpoint(source.checkpoint);
      const afterOffset = checkpoint.streamCursor?.afterOffset ?? 0;
      const batch = await this.client.streamRead({
        streamId: ensured.stream_id,
        afterOffset,
        limit: 100,
      });

      let appended = 0;
      let deduped = 0;
      for (const event of batch.events) {
        const rawPayload = asRecord(event.raw_payload);
        if (Object.keys(rawPayload).length === 0) {
          continue;
        }
        const mapped = profile.mapRawEvent(rawPayload, profileSource);
        if (!mapped) {
          continue;
        }
        const result = await this.appendSourceEvent({
          sourceId: source.sourceId,
          sourceNativeId: mapped.sourceNativeId,
          eventVariant: mapped.eventVariant,
          occurredAt: mapped.occurredAt,
          metadata: mapped.metadata,
          rawPayload: mapped.rawPayload,
          deliveryHandle: mapped.deliveryHandle ?? null,
        });
        appended += result.appended;
        deduped += result.deduped;
      }

      const latestSource = this.store.getSource(sourceId);
      if (!latestSource) {
        throw new Error(`unknown source: ${sourceId}`);
      }
      this.store.updateSourceRuntime(sourceId, {
        status: latestSource.status === "paused" ? "paused" : "active",
        checkpoint: JSON.stringify({
          managedSource: {
            namespace: ensured.namespace,
            sourceKey: ensured.source_key,
            streamId: ensured.stream_id,
          },
          streamCursor: {
            afterOffset: batch.next_after_offset,
          },
          lastEventAt: nowIso(),
          lastError: null,
        } satisfies RemoteSourceCheckpoint),
      });
      this.errorCounts.delete(sourceId);
      this.nextRetryAt.delete(sourceId);

      return {
        sourceId,
        sourceType: source.sourceType,
        appended,
        deduped,
        eventsRead: batch.events.length,
        note: `stream=${ensured.stream_id} status=${ensured.status}`,
      };
    } catch (error) {
      const source = this.store.getSource(sourceId);
      if (source) {
        const checkpoint = parseRemoteCheckpoint(source.checkpoint);
        const nextErrorCount = (this.errorCounts.get(sourceId) ?? 0) + 1;
        this.errorCounts.set(sourceId, nextErrorCount);
        this.nextRetryAt.set(sourceId, Date.now() + computeErrorBackoffMs(DEFAULT_BACKOFF_BASE_SECS, nextErrorCount));
        this.store.updateSourceRuntime(sourceId, {
          status: source.status === "paused" ? "paused" : "error",
          checkpoint: JSON.stringify({
            ...checkpoint,
            lastError: error instanceof Error ? error.message : String(error),
          } satisfies RemoteSourceCheckpoint),
        });
      }
      throw error;
    } finally {
      this.inFlight.delete(sourceId);
    }
  }
}

function profileInputSource(source: SubscriptionSource): SubscriptionSource {
  if (source.sourceType !== "remote_source") {
    return source;
  }
  const config = asRecord(source.config);
  return {
    ...source,
    config: asRecord(config.profileConfig),
  };
}

function defaultManagedBindingForSource(source: SubscriptionSource): { namespace: string; sourceKey: string } {
  return {
    namespace: MANAGED_SOURCE_NAMESPACE,
    sourceKey: `${source.sourceType}:${source.sourceKey}`,
  };
}

function managedBindingForSource(source: SubscriptionSource): { namespace: string; sourceKey: string } {
  const checkpoint = parseRemoteCheckpoint(source.checkpoint);
  const defaultBinding = defaultManagedBindingForSource(source);
  return {
    namespace: checkpoint.managedSource?.namespace ?? defaultBinding.namespace,
    sourceKey: checkpoint.managedSource?.sourceKey ?? defaultBinding.sourceKey,
  };
}

function parseRemoteCheckpoint(checkpoint: string | null | undefined): RemoteSourceCheckpoint {
  if (!checkpoint) {
    return {};
  }
  try {
    return JSON.parse(checkpoint) as RemoteSourceCheckpoint;
  } catch {
    return {};
  }
}

function computeErrorBackoffMs(baseIntervalSecs: number, errorCount: number): number {
  const baseMs = Math.max(1, baseIntervalSecs) * 1000;
  const multiplier = Math.min(2 ** Math.max(0, errorCount - 1), MAX_ERROR_BACKOFF_MULTIPLIER);
  return baseMs * multiplier;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}
