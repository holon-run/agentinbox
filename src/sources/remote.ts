import {
  ManagedSourceEnsureResponse,
  ManagedSourceListEntry,
  ManagedSourceView,
  ManagedStreamReadResponse,
  UxcDaemonClient,
} from "@holon-run/uxc-daemon-client";
import {
  ActivationItem,
  AppendSourceEventInput,
  FollowTemplateSpec,
  NotificationGrouping,
  SourcePollResult,
  SourceRuntimeState,
  SourceStream,
} from "../model";
import { resolveAgentInboxHome } from "../paths";
import { AgentInboxStore } from "../store";
import { nowIso } from "../util";
import {
  ExpandedFollowPlan,
  ExpandedSubscriptionInput,
  ExpandedSubscriptionPlan,
  ExpandFollowTemplateInput,
  LifecycleSignal,
  ManagedSourceSpec,
  RemoteSourceModuleRegistry,
} from "./remote_modules";

const REMOTE_SOURCE_TYPES = new Set<SourceStream["sourceType"]>([
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
  managedRuntime?: {
    status?: string | null;
    runId?: string | null;
    streamId?: string | null;
    lastError?: string | null;
    updatedAt?: string | null;
    startedAt?: string | null;
    stoppedAt?: string | null;
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
  sourceStatus(namespace: string, sourceKey: string): Promise<ManagedSourceView>;
  sourceList(): Promise<ManagedSourceListEntry[]>;
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

  sourceStatus(namespace: string, sourceKey: string): Promise<ManagedSourceView> {
    return this.client.sourceStatus(namespace, sourceKey);
  }

  sourceList(): Promise<ManagedSourceListEntry[]> {
    return this.client.sourceList();
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
  private readonly moduleRegistry: RemoteSourceModuleRegistry;
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
      moduleRegistry?: RemoteSourceModuleRegistry;
      client?: UxcRemoteSourceClient;
      homeDir?: string;
    },
  ) {
    this.moduleRegistry = options?.moduleRegistry ?? new RemoteSourceModuleRegistry();
    this.client = options?.client ?? new RpcUxcRemoteSourceClient();
    this.homeDir = options?.homeDir ?? resolveAgentInboxHome(process.env);
  }

  async ensureSource(source: SourceStream): Promise<void> {
    if (!REMOTE_SOURCE_TYPES.has(source.sourceType)) {
      return;
    }
    await this.syncSource(source.sourceId, true);
  }

  async validateSource(source: SourceStream): Promise<void> {
    if (!REMOTE_SOURCE_TYPES.has(source.sourceType)) {
      return;
    }
    const module = await this.moduleRegistry.resolve(source, this.homeDir);
    const moduleSource = moduleInputSource(source);
    module.validateConfig(moduleSource);
    module.buildManagedSourceSpec(moduleSource);
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
    const pausedAt = nowIso();
    const baseRuntime = checkpoint.managedRuntime ?? checkpointRuntimeFromSource(source, checkpoint) ?? {};
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
        managedRuntime: {
          ...baseRuntime,
          status: "stopped",
          updatedAt: pausedAt,
          stoppedAt: pausedAt,
          lastError: null,
        },
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

  async getSourceRuntime(source: SourceStream): Promise<SourceRuntimeState | null> {
    if (!REMOTE_SOURCE_TYPES.has(source.sourceType)) {
      return null;
    }
    const binding = managedBindingForSource(source);
    try {
      const managed = await this.client.sourceStatus(binding.namespace, binding.sourceKey);
      return runtimeStateFromManagedView(managed, "live");
    } catch {
      return runtimeStateFromCheckpoint(source);
    }
  }

  async listSourceRuntimes(sources: SourceStream[]): Promise<Map<string, SourceRuntimeState | null>> {
    const result = new Map<string, SourceRuntimeState | null>();
    const remoteSources = sources.filter((source) => REMOTE_SOURCE_TYPES.has(source.sourceType));
    for (const source of sources) {
      if (!REMOTE_SOURCE_TYPES.has(source.sourceType)) {
        result.set(source.sourceId, null);
      }
    }
    if (remoteSources.length === 0) {
      return result;
    }

    try {
      const managedSources = await this.client.sourceList();
      const byBinding = new Map(
        managedSources.map((entry) => [managedSourceBindingKey(entry.namespace, entry.source_key), entry] as const),
      );
      for (const source of remoteSources) {
        const binding = managedBindingForSource(source);
        const live = byBinding.get(managedSourceBindingKey(binding.namespace, binding.sourceKey));
        result.set(
          source.sourceId,
          live ? runtimeStateFromManagedSourceListEntry(live, "live") : runtimeStateFromCheckpoint(source),
        );
      }
      return result;
    } catch {
      for (const source of remoteSources) {
        result.set(source.sourceId, runtimeStateFromCheckpoint(source));
      }
      return result;
    }
  }

  async projectLifecycleSignal(source: SourceStream, rawPayload: Record<string, unknown>): Promise<LifecycleSignal | null> {
    if (!REMOTE_SOURCE_TYPES.has(source.sourceType)) {
      return null;
    }
    const module = await this.moduleRegistry.resolve(source, this.homeDir);
    if (typeof module.projectLifecycleSignal !== "function") {
      return null;
    }
    return module.projectLifecycleSignal(rawPayload, moduleInputSource(source));
  }

  async expandSubscriptionShortcut(
    source: SourceStream,
    input: { name: string; args?: Record<string, unknown> },
  ): Promise<ExpandedSubscriptionPlan | null> {
    if (!REMOTE_SOURCE_TYPES.has(source.sourceType)) {
      return null;
    }
    const module = await this.moduleRegistry.resolve(source, this.homeDir);
    if (typeof module.expandSubscriptionShortcut !== "function") {
      return null;
    }
    const expanded = module.expandSubscriptionShortcut({
      name: input.name,
      args: input.args,
      source: moduleInputSource(source),
    });
    return normalizeExpandedSubscriptionPlan(expanded);
  }

  async listFollowTemplates(source: SourceStream): Promise<FollowTemplateSpec[]> {
    if (!REMOTE_SOURCE_TYPES.has(source.sourceType)) {
      return [];
    }
    const module = await this.moduleRegistry.resolve(source, this.homeDir);
    if (typeof module.listFollowTemplates !== "function") {
      return [];
    }
    return module.listFollowTemplates(moduleInputSource(source));
  }

  async expandFollowTemplate(
    source: SourceStream,
    input: ExpandFollowTemplateInput,
  ): Promise<ExpandedFollowPlan | null> {
    if (!REMOTE_SOURCE_TYPES.has(source.sourceType)) {
      return null;
    }
    const module = await this.moduleRegistry.resolve(source, this.homeDir);
    if (typeof module.expandFollowTemplate !== "function") {
      return null;
    }
    return module.expandFollowTemplate({
      template: input.template,
      args: input.args,
      source: moduleInputSource(source),
    });
  }

  async deriveInlinePreview(source: SourceStream, item: ActivationItem): Promise<string | null> {
    if (!REMOTE_SOURCE_TYPES.has(source.sourceType)) {
      return null;
    }
    const module = await this.moduleRegistry.resolve(source, this.homeDir);
    if (typeof module.deriveInlinePreview !== "function") {
      return null;
    }
    return module.deriveInlinePreview(item, moduleInputSource(source));
  }

  async deriveNotificationGrouping(source: SourceStream, item: ActivationItem): Promise<NotificationGrouping | null> {
    if (!REMOTE_SOURCE_TYPES.has(source.sourceType)) {
      return null;
    }
    const module = await this.moduleRegistry.resolve(source, this.homeDir);
    if (typeof module.deriveNotificationGrouping !== "function") {
      return null;
    }
    return module.deriveNotificationGrouping(item, moduleInputSource(source));
  }

  async summarizeDigestThread(
    source: SourceStream,
    items: ActivationItem[],
    grouping: NotificationGrouping,
  ): Promise<string | null> {
    if (!REMOTE_SOURCE_TYPES.has(source.sourceType)) {
      return null;
    }
    const module = await this.moduleRegistry.resolve(source, this.homeDir);
    if (typeof module.summarizeDigestThread !== "function") {
      return null;
    }
    return module.summarizeDigestThread(items, moduleInputSource(source), grouping);
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

      const module = await this.moduleRegistry.resolve(source, this.homeDir);
      const moduleSource = moduleInputSource(source);
      module.validateConfig(moduleSource);
      const spec = module.buildManagedSourceSpec(moduleSource);
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
        const mapped = await module.mapRawEvent(rawPayload, moduleSource);
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
          managedRuntime: checkpointRuntimeFromEnsureResponse(
            ensured,
            checkpoint.managedRuntime ?? null,
            nowIso(),
          ),
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
            managedRuntime: checkpointRuntimeWithError(
              checkpoint.managedRuntime ?? checkpointRuntimeFromSource(source, checkpoint),
              error instanceof Error ? error.message : String(error),
              nowIso(),
            ),
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

function normalizeExpandedSubscriptionPlan(
  value: ExpandedSubscriptionInput | ExpandedSubscriptionPlan | null,
): ExpandedSubscriptionPlan | null {
  if (!value) {
    return null;
  }
  if (isExpandedSubscriptionPlan(value)) {
    return {
      members: value.members.map((member) => ({
        streamKind: typeof member.streamKind === "string" ? member.streamKind : null,
        filter: member.filter,
        trackedResourceRef: member.trackedResourceRef ?? null,
        cleanupPolicy: member.cleanupPolicy ?? null,
      })),
    };
  }
  return {
    members: [{
      streamKind: null,
      filter: value.filter,
      trackedResourceRef: value.trackedResourceRef ?? null,
      cleanupPolicy: value.cleanupPolicy ?? null,
    }],
  };
}

function isExpandedSubscriptionPlan(
  value: ExpandedSubscriptionInput | ExpandedSubscriptionPlan,
): value is ExpandedSubscriptionPlan {
  return "members" in value && Array.isArray(value.members);
}

function moduleInputSource(source: SourceStream): SourceStream {
  if (source.sourceType !== "remote_source") {
    return source;
  }
  const config = asRecord(source.config);
  return {
    ...source,
    config: asRecord(config.moduleConfig),
  };
}

function defaultManagedBindingForSource(source: SourceStream): { namespace: string; sourceKey: string } {
  return {
    namespace: MANAGED_SOURCE_NAMESPACE,
    sourceKey: `${source.sourceType}:${source.sourceKey}`,
  };
}

function managedBindingForSource(source: SourceStream): { namespace: string; sourceKey: string } {
  const checkpoint = parseRemoteCheckpoint(source.checkpoint);
  const defaultBinding = defaultManagedBindingForSource(source);
  return {
    namespace: checkpoint.managedSource?.namespace ?? defaultBinding.namespace,
    sourceKey: checkpoint.managedSource?.sourceKey ?? defaultBinding.sourceKey,
  };
}

function managedSourceBindingKey(namespace: string, sourceKey: string): string {
  return `${namespace}:${sourceKey}`;
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

function runtimeStateFromManagedView(
  managed: ManagedSourceView,
  observation: SourceRuntimeState["observation"],
): SourceRuntimeState {
  return {
    backend: "uxc",
    observation,
    namespace: managed.namespace,
    sourceKey: managed.source_key,
    status: managed.status,
    runId: managed.run_id,
    streamId: managed.stream_id,
    lastError: managed.last_error ?? null,
    updatedAt: unixToIso(managed.updated_at_unix),
    startedAt: unixToIso(managed.started_at_unix ?? null),
    stoppedAt: unixToIso(managed.stopped_at_unix ?? null),
  };
}

function runtimeStateFromManagedSourceListEntry(
  managed: ManagedSourceListEntry,
  observation: SourceRuntimeState["observation"],
): SourceRuntimeState {
  return {
    backend: "uxc",
    observation,
    namespace: managed.namespace,
    sourceKey: managed.source_key,
    status: managed.status,
    runId: managed.run_id,
    streamId: managed.stream_id,
    lastError: managed.last_error ?? null,
    updatedAt: unixToIso(managed.updated_at_unix),
    startedAt: null,
    stoppedAt: null,
  };
}

function runtimeStateFromCheckpoint(source: SourceStream): SourceRuntimeState | null {
  const checkpoint = parseRemoteCheckpoint(source.checkpoint);
  const binding = managedBindingForSource(source);
  const runtime = checkpoint.managedRuntime;
  const streamId = runtime?.streamId ?? checkpoint.managedSource?.streamId ?? null;
  if (!runtime && !checkpoint.managedSource) {
    return null;
  }
  return {
    backend: "uxc",
    observation: "cached",
    namespace: binding.namespace,
    sourceKey: binding.sourceKey,
    status: runtime?.status ?? null,
    runId: runtime?.runId ?? null,
    streamId,
    lastError: runtime?.lastError ?? checkpoint.lastError ?? null,
    updatedAt: runtime?.updatedAt ?? source.updatedAt,
    startedAt: runtime?.startedAt ?? null,
    stoppedAt: runtime?.stoppedAt ?? null,
  };
}

function checkpointRuntimeFromEnsureResponse(
  ensured: ManagedSourceEnsureResponse,
  previous: RemoteSourceCheckpoint["managedRuntime"] | null,
  observedAt: string,
): NonNullable<RemoteSourceCheckpoint["managedRuntime"]> {
  return {
    status: ensured.status,
    runId: ensured.run_id,
    streamId: ensured.stream_id,
    lastError: null,
    updatedAt: observedAt,
    startedAt: previous?.runId === ensured.run_id ? previous.startedAt ?? null : null,
    stoppedAt: null,
  };
}

function checkpointRuntimeWithError(
  previous: RemoteSourceCheckpoint["managedRuntime"] | null,
  lastError: string,
  observedAt: string,
): NonNullable<RemoteSourceCheckpoint["managedRuntime"]> {
  return {
    status: previous?.status ?? null,
    runId: previous?.runId ?? null,
    streamId: previous?.streamId ?? null,
    lastError,
    updatedAt: observedAt,
    startedAt: previous?.startedAt ?? null,
    stoppedAt: previous?.stoppedAt ?? null,
  };
}

function checkpointRuntimeFromSource(
  source: SourceStream,
  checkpoint: RemoteSourceCheckpoint = parseRemoteCheckpoint(source.checkpoint),
): NonNullable<RemoteSourceCheckpoint["managedRuntime"]> | null {
  if (checkpoint.managedRuntime) {
    return checkpoint.managedRuntime;
  }
  if (!checkpoint.managedSource) {
    return null;
  }
  return {
    status: null,
    runId: null,
    streamId: checkpoint.managedSource.streamId,
    lastError: checkpoint.lastError ?? null,
    updatedAt: source.updatedAt,
    startedAt: null,
    stoppedAt: null,
  };
}

function unixToIso(value: number | null | undefined): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  return new Date(value * 1000).toISOString();
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
