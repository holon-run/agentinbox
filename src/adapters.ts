import {
  AppendSourceEventInput,
  DeliveryAttempt,
  DeliveryRequest,
  SourcePollResult,
  SourceType,
  SubscriptionSource,
} from "./model";
import { AgentInboxStore } from "./store";
import { GithubDeliveryAdapter, GithubSourceRuntime } from "./sources/github";

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

class UxcBackedStubAdapter implements SourceAdapter, DeliveryAdapter {
  async ensureSource(_source: SubscriptionSource): Promise<void> {
    return;
  }

  async pollSource(sourceId: string): Promise<SourcePollResult> {
    return {
      sourceId,
      sourceType: "feishu_bot",
      appended: 0,
      deduped: 0,
      eventsRead: 0,
      note: "provider adapter scaffolded; wire this to uxc in the next milestone",
    };
  }

  async send(_request: DeliveryRequest, _attempt: DeliveryAttempt): Promise<{ status: "accepted"; note: string }> {
    return {
      status: "accepted",
      note: "provider adapter scaffolded; wire this to uxc in the next milestone",
    };
  }
}

export class AdapterRegistry {
  private readonly fixtureSource = new NoopSourceAdapter("fixture");
  private readonly feishuSource = new NoopSourceAdapter("feishu_bot");
  private readonly githubSource: GithubSourceRuntime;
  private readonly fixtureDelivery = new NoopDeliveryAdapter();
  private readonly githubDelivery = new GithubDeliveryAdapter();
  private readonly stub = new UxcBackedStubAdapter();

  constructor(store: AgentInboxStore, appendSourceEvent: (input: AppendSourceEventInput) => Promise<{ appended: number; deduped: number }>) {
    this.githubSource = new GithubSourceRuntime(store, appendSourceEvent);
  }

  sourceAdapterFor(type: SourceType): SourceAdapter {
    if (type === "fixture") {
      return this.fixtureSource;
    }
    if (type === "github_repo") {
      return this.githubSource;
    }
    if (type === "feishu_bot") {
      return this.feishuSource;
    }
    return this.stub;
  }

  deliveryAdapterFor(provider: string): DeliveryAdapter {
    if (provider === "fixture") {
      return this.fixtureDelivery;
    }
    if (provider === "github") {
      return this.githubDelivery;
    }
    return this.stub;
  }

  async start(): Promise<void> {
    await this.githubSource.start?.();
  }

  async stop(): Promise<void> {
    await this.githubSource.stop?.();
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
      github: this.githubSource.status?.() ?? {},
    };
  }
}
