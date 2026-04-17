import {
  ActivationItem,
  AppendSourceEventInput,
  DeliveryAttempt,
  DeliveryRequest,
  DeliveryHandle,
  DeliveryOperationDescriptor,
  SubscriptionSource,
  ResolvedSourceIdentity,
  ResolvedSourceSchema,
  SourcePollResult,
  SourceType,
} from "./model";
import { AgentInboxStore } from "./store";
import { resolveAgentInboxHome } from "./paths";
import { FeishuDeliveryAdapter } from "./sources/feishu";
import { GithubDeliveryAdapter } from "./sources/github";
import { RemoteSourceRuntime, UxcRemoteSourceClient } from "./sources/remote";
import { ExpandedSubscriptionInput, LifecycleSignal, RemoteSourceModule, RemoteSourceModuleRegistry } from "./sources/remote_modules";
import { resolveSourceIdentity, resolveSourceSchema } from "./source_resolution";
import { compatSourceTypeForStream } from "./source_hosts";

export interface SourceAdapter {
  ensureSource(source: SubscriptionSource): Promise<void>;
  validateSource?(source: SubscriptionSource): Promise<void>;
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

  async ensureSource(_source: SubscriptionSource): Promise<void> {
    return;
  }

  async validateSource(_source: SubscriptionSource): Promise<void> {
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
    },
  ) {
    this.homeDir = options?.homeDir ?? resolveAgentInboxHome(process.env);
    this.remoteModuleRegistry = options?.remoteModuleRegistry ?? new RemoteSourceModuleRegistry();
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

  async pollSource(source: SubscriptionSource): Promise<SourcePollResult> {
    const compatSourceType = compatSourceTypeForStream(source);
    const adapter = this.sourceAdapterFor(compatSourceType);
    if (!adapter.pollSource) {
      return {
        sourceId: source.sourceId,
        sourceType: compatSourceType,
        appended: 0,
        deduped: 0,
        eventsRead: 0,
        note: "source type does not support polling",
      };
    }
    return adapter.pollSource(source.sourceId);
  }

  async pauseSource(source: SubscriptionSource): Promise<void> {
    const compatSourceType = compatSourceTypeForStream(source);
    const adapter = this.sourceAdapterFor(compatSourceType);
    if (!adapter.pauseSource) {
      throw new Error(`source type ${compatSourceType} does not support pause`);
    }
    await adapter.pauseSource?.(source.sourceId);
  }

  async resumeSource(source: SubscriptionSource): Promise<void> {
    const compatSourceType = compatSourceTypeForStream(source);
    const adapter = this.sourceAdapterFor(compatSourceType);
    if (!adapter.resumeSource) {
      throw new Error(`source type ${compatSourceType} does not support resume`);
    }
    await adapter.resumeSource?.(source.sourceId);
  }

  async removeSource(source: SubscriptionSource): Promise<void> {
    const adapter = this.sourceAdapterFor(compatSourceTypeForStream(source));
    await adapter.removeSource?.(source.sourceId);
  }

  async resolveSourceIdentity(source: SubscriptionSource): Promise<ResolvedSourceIdentity> {
    return resolveSourceIdentity(source, {
      homeDir: this.homeDir,
      moduleRegistry: this.remoteModuleRegistry,
    });
  }

  async resolveSourceSchema(source: SubscriptionSource): Promise<ResolvedSourceSchema> {
    return resolveSourceSchema(source, {
      homeDir: this.homeDir,
      moduleRegistry: this.remoteModuleRegistry,
    });
  }

  async projectLifecycleSignal(source: SubscriptionSource, rawPayload: Record<string, unknown>): Promise<LifecycleSignal | null> {
    if (compatSourceTypeForStream(source) === "local_event") {
      return null;
    }
    return this.remoteSource.projectLifecycleSignal(source, rawPayload);
  }

  async expandSubscriptionShortcut(
    source: SubscriptionSource,
    input: { name: string; args?: Record<string, unknown> },
  ): Promise<ExpandedSubscriptionInput | null> {
    if (compatSourceTypeForStream(source) === "local_event") {
      return null;
    }
    return this.remoteSource.expandSubscriptionShortcut(source, input);
  }

  async deriveInlinePreview(source: SubscriptionSource, item: ActivationItem): Promise<string | null> {
    if (compatSourceTypeForStream(source) === "local_event") {
      return null;
    }
    return this.remoteSource.deriveInlinePreview(source, item);
  }

  async listDeliveryOperations(
    source: SubscriptionSource | null,
    handle: DeliveryHandle,
  ): Promise<DeliveryOperationDescriptor[]> {
    const module = await this.resolveDeliveryModule(source, handle);
    if (!module?.listDeliveryOperations) {
      return [];
    }
    return module.listDeliveryOperations({ handle, source });
  }

  async invokeDeliveryOperation(
    source: SubscriptionSource | null,
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

  private async resolveDeliveryModule(source: SubscriptionSource | null, handle: DeliveryHandle): Promise<RemoteSourceModule | null> {
    if (source) {
      if (compatSourceTypeForStream(source) === "local_event") {
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

function syntheticBuiltinSource(sourceType: "github_repo" | "feishu_bot"): SubscriptionSource {
  return {
    sourceId: `builtin:${sourceType}`,
    hostId: `builtin-host:${sourceType}`,
    streamKind: sourceType === "github_repo" ? "repo_events" : "message_events",
    streamKey: sourceType,
    compatSourceType: sourceType,
    sourceType,
    sourceKey: sourceType,
    status: "active",
    createdAt: "",
    updatedAt: "",
    config: {},
  };
}
