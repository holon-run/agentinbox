import { DeliveryAttempt, DeliveryRequest, EmitItemInput, SourcePollResult, SourceType, SubscriptionSource } from "./model";
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
  async ensureSource(_source: SubscriptionSource): Promise<void> {
    return;
  }

  async pollSource(sourceId: string): Promise<SourcePollResult> {
    return {
      sourceId,
      sourceType: "fixture",
      inserted: 0,
      ignored: 0,
      eventsRead: 0,
      note: "fixture source has no background poller",
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
      sourceType: "github_repo",
      inserted: 0,
      ignored: 0,
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
  private readonly fixtureSource = new NoopSourceAdapter();
  private readonly githubSource: GithubSourceRuntime;
  private readonly fixtureDelivery = new NoopDeliveryAdapter();
  private readonly githubDelivery = new GithubDeliveryAdapter();
  private readonly stub = new UxcBackedStubAdapter();

  constructor(store: AgentInboxStore, emitItem: (input: EmitItemInput) => Promise<{ inserted: number }>) {
    this.githubSource = new GithubSourceRuntime(store, emitItem);
  }

  sourceAdapterFor(type: SourceType): SourceAdapter {
    if (type === "fixture") {
      return this.fixtureSource;
    }
    if (type === "github_repo") {
      return this.githubSource;
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
        inserted: 0,
        ignored: 0,
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
