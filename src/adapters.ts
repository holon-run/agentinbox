import {
  AppendSourceEventInput,
  DeliveryAttempt,
  DeliveryRequest,
  SourcePollResult,
  SourceType,
  SubscriptionSource,
} from "./model";
import { AgentInboxStore } from "./store";
import { FeishuDeliveryAdapter } from "./sources/feishu";
import { GithubDeliveryAdapter } from "./sources/github";
import { RemoteSourceRuntime, UxcRemoteSourceClient } from "./sources/remote";
import { RemoteSourceProfileRegistry } from "./sources/remote_profiles";

export interface SourceAdapter {
  ensureSource(source: SubscriptionSource): Promise<void>;
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

  constructor(
    store: AgentInboxStore,
    appendSourceEvent: (input: AppendSourceEventInput) => Promise<{ appended: number; deduped: number }>,
    options?: {
      homeDir?: string;
      remoteSourceClient?: UxcRemoteSourceClient;
      remoteProfileRegistry?: RemoteSourceProfileRegistry;
    },
  ) {
    this.remoteSource = new RemoteSourceRuntime(store, appendSourceEvent, {
      homeDir: options?.homeDir,
      client: options?.remoteSourceClient,
      profileRegistry: options?.remoteProfileRegistry,
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

  async pauseSource(source: SubscriptionSource): Promise<void> {
    const adapter = this.sourceAdapterFor(source.sourceType);
    if (!adapter.pauseSource) {
      throw new Error(`source type ${source.sourceType} does not support pause`);
    }
    await adapter.pauseSource?.(source.sourceId);
  }

  async resumeSource(source: SubscriptionSource): Promise<void> {
    const adapter = this.sourceAdapterFor(source.sourceType);
    if (!adapter.resumeSource) {
      throw new Error(`source type ${source.sourceType} does not support resume`);
    }
    await adapter.resumeSource?.(source.sourceId);
  }

  async removeSource(source: SubscriptionSource): Promise<void> {
    const adapter = this.sourceAdapterFor(source.sourceType);
    await adapter.removeSource?.(source.sourceId);
  }

  status(): Record<string, unknown> {
    return {
      remote: this.remoteSource.status?.() ?? {},
    };
  }
}
