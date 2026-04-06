import {
  AppendSourceEventInput,
  DeliveryAttempt,
  DeliveryRequest,
  SourcePollResult,
  SourceType,
  SubscriptionSource,
} from "./model";
import { AgentInboxStore } from "./store";
import { FeishuDeliveryAdapter, FeishuSourceRuntime } from "./sources/feishu";
import { GithubDeliveryAdapter, GithubSourceRuntime } from "./sources/github";
import { GithubCiSourceRuntime } from "./sources/github_ci";

export interface SourceAdapter {
  ensureSource(source: SubscriptionSource): Promise<void>;
  pollSource?(sourceId: string): Promise<SourcePollResult>;
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
  private readonly fixtureSource = new NoopSourceAdapter("fixture");
  private readonly customSource = new NoopSourceAdapter("custom");
  private readonly feishuSource: FeishuSourceRuntime;
  private readonly githubSource: GithubSourceRuntime;
  private readonly githubCiSource: GithubCiSourceRuntime;
  private readonly fixtureDelivery = new NoopDeliveryAdapter();
  private readonly feishuDelivery = new FeishuDeliveryAdapter();
  private readonly githubDelivery = new GithubDeliveryAdapter();

  constructor(store: AgentInboxStore, appendSourceEvent: (input: AppendSourceEventInput) => Promise<{ appended: number; deduped: number }>) {
    this.feishuSource = new FeishuSourceRuntime(store, appendSourceEvent);
    this.githubSource = new GithubSourceRuntime(store, appendSourceEvent);
    this.githubCiSource = new GithubCiSourceRuntime(store, appendSourceEvent);
  }

  sourceAdapterFor(type: SourceType): SourceAdapter {
    if (type === "fixture") {
      return this.fixtureSource;
    }
    if (type === "custom") {
      return this.customSource;
    }
    if (type === "github_repo") {
      return this.githubSource;
    }
    if (type === "github_repo_ci") {
      return this.githubCiSource;
    }
    if (type === "feishu_bot") {
      return this.feishuSource;
    }
    return this.fixtureSource;
  }

  deliveryAdapterFor(provider: string): DeliveryAdapter {
    if (provider === "fixture") {
      return this.fixtureDelivery;
    }
    if (provider === "feishu") {
      return this.feishuDelivery;
    }
    if (provider === "github") {
      return this.githubDelivery;
    }
    return this.fixtureDelivery;
  }

  async start(): Promise<void> {
    await this.feishuSource.start?.();
    await this.githubSource.start?.();
    await this.githubCiSource.start?.();
  }

  async stop(): Promise<void> {
    await this.feishuSource.stop?.();
    await this.githubSource.stop?.();
    await this.githubCiSource.stop?.();
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

  status(): Record<string, unknown> {
    return {
      feishu: this.feishuSource.status?.() ?? {},
      github: this.githubSource.status?.() ?? {},
      githubCi: this.githubCiSource.status?.() ?? {},
    };
  }
}
