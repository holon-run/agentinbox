import {
  ActivationItem,
  AppendSourceEventInput,
  DeliveryAttempt,
  DeliveryRequest,
  DeliveryHandle,
  DeliveryOperationDescriptor,
  FollowTemplateSpec,
  NotificationGrouping,
  ResolvedSourceIdentity,
  ResolvedSourceSchema,
  SourcePollResult,
  SourceRuntimeState,
  SourceStream,
  SourceType,
} from "./model";
import { AgentInboxStore } from "./store";
import { resolveAgentInboxHome } from "./paths";
import { FeishuDeliveryAdapter } from "./sources/feishu";
import { GithubDeliveryAdapter } from "./sources/github";
import { RemoteSourceRuntime, UxcRemoteSourceClient } from "./sources/remote";
import { ExpandedFollowPlan, ExpandedSubscriptionPlan, ExpandFollowTemplateInput, LifecycleSignal, RemoteSourceModule, RemoteSourceModuleRegistry, builtinRemoteSourceTypes } from "./sources/remote_modules";
import { GithubCallClient } from "./sources/github";
import { resolveSourceIdentity, resolveSourceSchema } from "./source_resolution";

export interface SourceAdapter {
  ensureSource(source: SourceStream): Promise<void>;
  validateSource?(source: SourceStream): Promise<void>;
  pollSource?(sourceId: string): Promise<SourcePollResult>;
  pauseSource?(sourceId: string): Promise<void>;
  resumeSource?(sourceId: string): Promise<void>;
  removeSource?(sourceId: string): Promise<void>;
  start?(): Promise<void>;
  stop?(): Promise<void>;
  status?(): Record<string, unknown>;
}

export interface DeliveryAdapter {
  send(request: DeliveryRequest, attempt: DeliveryAttempt): Promise<{ status: DeliveryAttempt["status"]; note: string }>;
}

class NoopSourceAdapter implements SourceAdapter {
  constructor(private readonly sourceType: SourceType) {}

  async ensureSource(_source: SourceStream): Promise<void> {
    return;
  }

  async validateSource(_source: SourceStream): Promise<void> {
    return;
  }

  async pollSource(sourceId: string): Promise<SourcePollResult> {
    return {
      sourceId,
      sourceType: this.sourceType,
      appended: 0,
      deduped: 0,
      eventsRead: 0,
      note: `${this.sourceType} source has no background poller`,
    };
  }

}

class NoopDeliveryAdapter implements DeliveryAdapter {
  async send(_request: DeliveryRequest, _attempt: DeliveryAttempt): Promise<{ status: "accepted"; note: string }> {
    return { status: "accepted", note: "accepted without provider-side delivery" };
  }
}

export class AdapterRegistry {
  private readonly localEventSource = new NoopSourceAdapter("local_event");
  private readonly remoteSource: RemoteSourceRuntime;
  private readonly defaultDelivery = new NoopDeliveryAdapter();
  private readonly feishuDelivery = new FeishuDeliveryAdapter();
  private readonly githubDelivery = new GithubDeliveryAdapter();
  private readonly homeDir: string;
  private readonly remoteModuleRegistry: RemoteSourceModuleRegistry;

  constructor(
    store: AgentInboxStore,
    appendSourceEvent: (input: AppendSourceEventInput) => Promise<{ appended: number; deduped: number }>,
    options?: {
      homeDir?: string;
      remoteSourceClient?: UxcRemoteSourceClient;
      remoteModuleRegistry?: RemoteSourceModuleRegistry;
      githubCallClient?: GithubCallClient;
    },
  ) {
    this.homeDir = options?.homeDir ?? resolveAgentInboxHome(process.env);
    this.remoteModuleRegistry = options?.remoteModuleRegistry ?? new RemoteSourceModuleRegistry({
      githubCallClient: options?.githubCallClient,
    });
    this.remoteSource = new RemoteSourceRuntime(store, appendSourceEvent, {
      homeDir: this.homeDir,
      client: options?.remoteSourceClient,
      moduleRegistry: this.remoteModuleRegistry,
    });
  }

  sourceAdapterFor(type: SourceType): SourceAdapter {
    if (type === "local_event") {
      return this.localEventSource;
    }
    if (type === "remote_source") {
      return this.remoteSource;
    }
    if (type === "github_repo") {
      return this.remoteSource;
    }
    if (type === "github_repo_ci") {
      return this.remoteSource;
    }
    if (type === "feishu_bot") {
      return this.remoteSource;
    }
    return this.localEventSource;
  }

  deliveryAdapterFor(provider: string): DeliveryAdapter {
    if (provider === "feishu") {
      return this.feishuDelivery;
    }
    if (provider === "github") {
      return this.githubDelivery;
    }
    return this.defaultDelivery;
  }

  async start(): Promise<void> {
    await this.remoteSource.start?.();
  }

  async stop(): Promise<void> {
    await this.remoteSource.stop?.();
  }

  async pollSource(source: SourceStream): Promise<SourcePollResult> {
    const adapter = this.sourceAdapterFor(source.sourceType);
    if (!adapter.pollSource) {
      return {
        sourceId: source.sourceId,
        sourceType: source.sourceType,
        appended: 0,
        deduped: 0,
        eventsRead: 0,
        note: "source type does not support polling",
      };
    }
    return adapter.pollSource(source.sourceId);
  }

  async pauseSource(source: SourceStream): Promise<void> {
    const adapter = this.sourceAdapterFor(source.sourceType);
    if (!adapter.pauseSource) {
      throw new Error(`source type ${source.sourceType} does not support pause`);
    }
    await adapter.pauseSource?.(source.sourceId);
  }

  async resumeSource(source: SourceStream): Promise<void> {
    const adapter = this.sourceAdapterFor(source.sourceType);
    if (!adapter.resumeSource) {
      throw new Error(`source type ${source.sourceType} does not support resume`);
    }
    await adapter.resumeSource?.(source.sourceId);
  }

  async removeSource(source: SourceStream): Promise<void> {
    const adapter = this.sourceAdapterFor(source.sourceType);
    await adapter.removeSource?.(source.sourceId);
  }

  async resolveSourceIdentity(source: SourceStream): Promise<ResolvedSourceIdentity> {
    return resolveSourceIdentity(source, {
      homeDir: this.homeDir,
      moduleRegistry: this.remoteModuleRegistry,
    });
  }

  async resolveSourceSchema(source: SourceStream): Promise<ResolvedSourceSchema> {
    return resolveSourceSchema(source, {
      homeDir: this.homeDir,
      moduleRegistry: this.remoteModuleRegistry,
    });
  }

  async projectLifecycleSignal(source: SourceStream, rawPayload: Record<string, unknown>): Promise<LifecycleSignal | null> {
    if (source.sourceType === "local_event") {
      return null;
    }
    return this.remoteSource.projectLifecycleSignal(source, rawPayload);
  }

  async expandSubscriptionShortcut(
    source: SourceStream,
    input: { name: string; args?: Record<string, unknown> },
  ): Promise<ExpandedSubscriptionPlan | null> {
    if (source.sourceType === "local_event") {
      return null;
    }
    return this.remoteSource.expandSubscriptionShortcut(source, input);
  }

  async listFollowTemplates(source: SourceStream): Promise<FollowTemplateSpec[]> {
    if (source.sourceType === "local_event") {
      return [];
    }
    return this.remoteSource.listFollowTemplates(source);
  }

  async expandFollowTemplate(
    source: SourceStream,
    input: ExpandFollowTemplateInput,
  ): Promise<ExpandedFollowPlan | null> {
    if (source.sourceType === "local_event") {
      return null;
    }
    return this.remoteSource.expandFollowTemplate(source, input);
  }

  followPreviewRefsForProviderOrKind(
    providerOrKind: string,
    config?: Record<string, unknown>,
  ): string[] {
    const trimmed = providerOrKind.trim();
    if (trimmed.length === 0) {
      throw new Error("follow requires a providerOrKind");
    }
    if (isExplicitFollowPreviewRef(trimmed)) {
      return [trimmed];
    }
    const candidates = hasRemoteSourceModulePath(config)
      ? ["remote_source", ...builtinRemoteSourceTypes()]
      : builtinRemoteSourceTypes();
    return Array.from(new Set(candidates));
  }

  async deriveInlinePreview(source: SourceStream, item: ActivationItem): Promise<string | null> {
    if (source.sourceType === "local_event") {
      return null;
    }
    return this.remoteSource.deriveInlinePreview(source, item);
  }

  async deriveNotificationGrouping(source: SourceStream, item: ActivationItem): Promise<NotificationGrouping | null> {
    if (source.sourceType === "local_event") {
      return null;
    }
    return this.remoteSource.deriveNotificationGrouping(source, item);
  }

  async getSourceRuntime(source: SourceStream): Promise<SourceRuntimeState | null> {
    if (source.sourceType === "local_event") {
      return null;
    }
    return this.remoteSource.getSourceRuntime(source);
  }

  async listSourceRuntimes(sources: SourceStream[]): Promise<Map<string, SourceRuntimeState | null>> {
    return this.remoteSource.listSourceRuntimes(sources);
  }

  async summarizeDigestThread(
    source: SourceStream,
    items: ActivationItem[],
    grouping: NotificationGrouping,
  ): Promise<string | null> {
    if (source.sourceType === "local_event") {
      return null;
    }
    return this.remoteSource.summarizeDigestThread(source, items, grouping);
  }

  async listDeliveryOperations(
    source: SourceStream | null,
    handle: DeliveryHandle,
  ): Promise<DeliveryOperationDescriptor[]> {
    const module = await this.resolveDeliveryModule(source, handle);
    if (!module?.listDeliveryOperations) {
      return [];
    }
    return module.listDeliveryOperations({ handle, source });
  }

  async invokeDeliveryOperation(
    source: SourceStream | null,
    handle: DeliveryHandle,
    operation: string,
    input: Record<string, unknown>,
    attempt: DeliveryAttempt,
  ): Promise<{ status: DeliveryAttempt["status"]; note: string }> {
    const module = await this.resolveDeliveryModule(source, handle);
    if (!module?.invokeDeliveryOperation) {
      throw new Error(`delivery operations are not supported for provider ${handle.provider}`);
    }
    return module.invokeDeliveryOperation({ handle, operation, input, attempt, source });
  }

  status(): Record<string, unknown> {
    return {
      remote: this.remoteSource.status?.() ?? {},
    };
  }

  private async resolveDeliveryModule(source: SourceStream | null, handle: DeliveryHandle): Promise<RemoteSourceModule | null> {
    if (source) {
      if (source.sourceType === "local_event") {
        return null;
      }
      return this.remoteModuleRegistry.resolve(source, this.homeDir);
    }
    if (handle.provider === "github") {
      return this.remoteModuleRegistry.resolve(syntheticBuiltinSource("github_repo"), this.homeDir);
    }
    if (handle.provider === "feishu") {
      return this.remoteModuleRegistry.resolve(syntheticBuiltinSource("feishu_bot"), this.homeDir);
    }
    return null;
  }
}

function isExplicitFollowPreviewRef(value: string): boolean {
  return (
    value === "local_event" ||
    value === "remote_source" ||
    value === "github_repo" ||
    value === "github_repo_ci" ||
    value === "feishu_bot" ||
    value.startsWith("remote:")
  );
}

function hasRemoteSourceModulePath(config: Record<string, unknown> | undefined): boolean {
  const modulePath = config?.modulePath;
  return typeof modulePath === "string" && modulePath.trim().length > 0;
}

function syntheticBuiltinSource(sourceType: "github_repo" | "feishu_bot"): SourceStream {
  return {
    sourceId: `builtin:${sourceType}`,
    hostId: `builtin-host:${sourceType}`,
    streamKind: sourceType === "github_repo" ? "repo_events" : "message_events",
    streamKey: sourceType,
    sourceType,
    sourceKey: sourceType,
    status: "active",
    createdAt: "",
    updatedAt: "",
    config: {},
  };
}
