import {
  Activation,
  DeliveryAttempt,
  DeliveryHandle,
  DeliveryRequest,
  EmitItemInput,
  InboxItem,
  Interest,
  RegisterInterestInput,
  RegisterSourceInput,
  SourcePollResult,
  SubscriptionSource,
} from "./model";
import { AgentInboxStore } from "./store";
import { AdapterRegistry } from "./adapters";
import { generateId, nowIso } from "./util";
import { matchInterest } from "./matcher";

export class AgentInboxService {
  constructor(
    private readonly store: AgentInboxStore,
    private readonly adapters: AdapterRegistry,
    private readonly activationDispatcher: ActivationDispatcher = new ActivationDispatcher(),
  ) {}

  async registerSource(input: RegisterSourceInput): Promise<SubscriptionSource> {
    const existing = this.store.getSourceByKey(input.sourceType, input.sourceKey);
    if (existing) {
      return existing;
    }
    const source: SubscriptionSource = {
      sourceId: generateId("src"),
      sourceType: input.sourceType,
      sourceKey: input.sourceKey,
      configRef: input.configRef ?? null,
      config: input.config ?? {},
      status: "active",
      checkpoint: null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    this.store.insertSource(source);
    await this.adapters.sourceAdapterFor(source.sourceType).ensureSource(source);
    return source;
  }

  registerInterest(input: RegisterInterestInput): Interest {
    const source = this.store.getSource(input.sourceId);
    if (!source) {
      throw new Error(`unknown source: ${input.sourceId}`);
    }
    const interest: Interest = {
      interestId: generateId("int"),
      agentId: input.agentId,
      sourceId: input.sourceId,
      mailboxId: input.mailboxId ?? `mbx_${input.agentId}`,
      matchRules: input.matchRules ?? {},
      activationTarget: input.activationTarget ?? null,
      createdAt: nowIso(),
    };
    this.store.insertInterest(interest);
    return interest;
  }

  async emitItem(input: EmitItemInput): Promise<{ inserted: number; items: InboxItem[]; activations: Activation[] }> {
    const source = this.store.getSource(input.sourceId);
    if (!source) {
      throw new Error(`unknown source: ${input.sourceId}`);
    }

    const interests = this.store.listInterestsForSource(input.sourceId);
    const items: InboxItem[] = [];
    const activations: Activation[] = [];

    for (const interest of interests) {
      const match = matchInterest(interest, input.metadata ?? {}, input.rawPayload ?? {});
      if (!match.matched) {
        continue;
      }
      const item: InboxItem = {
        itemId: generateId("item"),
        sourceId: input.sourceId,
        sourceNativeId: input.sourceNativeId,
        eventVariant: input.eventVariant,
        mailboxId: interest.mailboxId,
        occurredAt: input.occurredAt ?? nowIso(),
        metadata: { ...(input.metadata ?? {}), matchReason: match.reason, agentId: interest.agentId },
        rawPayload: input.rawPayload ?? {},
        deliveryHandle: input.deliveryHandle ?? defaultDeliveryHandleForSource(source, input),
        ackedAt: null,
      };
      const inserted = this.store.insertInboxItem(item);
      if (!inserted) {
        continue;
      }
      items.push(item);
      const activation: Activation = {
        activationId: generateId("act"),
        agentId: interest.agentId,
        mailboxId: interest.mailboxId,
        newItemCount: 1,
        summary: `${source.sourceType}:${source.sourceKey}:${input.eventVariant}`,
        createdAt: nowIso(),
        deliveredAt: null,
      };
      this.store.insertActivation(activation);
      activations.push(activation);
      await this.activationDispatcher.dispatch(interest.activationTarget, activation);
    }

    return { inserted: items.length, items, activations };
  }

  listMailboxIds(): string[] {
    return this.store.listMailboxIds();
  }

  listMailboxItems(mailboxId: string): InboxItem[] {
    return this.store.listInboxItems(mailboxId);
  }

  ackMailboxItems(mailboxId: string, itemIds: string[]): { acked: number } {
    return { acked: this.store.ackItems(mailboxId, itemIds, nowIso()) };
  }

  async pollSource(sourceId: string): Promise<SourcePollResult> {
    const source = this.store.getSource(sourceId);
    if (!source) {
      throw new Error(`unknown source: ${sourceId}`);
    }
    return this.adapters.pollSource(source);
  }

  async sendDelivery(request: DeliveryRequest): Promise<DeliveryAttempt & { note: string }> {
    const handle = resolveDeliveryHandle(request);
    const attempt: DeliveryAttempt = {
      deliveryId: generateId("dlv"),
      provider: handle.provider,
      surface: handle.surface,
      targetRef: handle.targetRef,
      threadRef: handle.threadRef ?? null,
      replyMode: handle.replyMode ?? null,
      kind: request.kind,
      payload: request.payload,
      status: "accepted",
      createdAt: nowIso(),
    };
    const adapter = this.adapters.deliveryAdapterFor(handle.provider);
    const result = await adapter.send(request, attempt);
    const storedAttempt = { ...attempt, status: result.status };
    this.store.insertDelivery(storedAttempt);
    return { ...storedAttempt, note: result.note };
  }

  status(): Record<string, unknown> {
    return {
      counts: this.store.getCounts(),
      sources: this.store.listSources(),
      interests: this.store.listInterests(),
      mailboxes: this.store.listMailboxIds(),
      adapters: this.adapters.status(),
      recentActivations: this.store.listActivations().slice(0, 10),
      recentDeliveries: this.store.listDeliveries().slice(0, 10),
    };
  }
}

function defaultDeliveryHandleForSource(source: SubscriptionSource, input: EmitItemInput): DeliveryHandle {
  return {
    provider: source.sourceType === "fixture" ? "fixture" : source.sourceType,
    surface: "inbox_item",
    targetRef: input.sourceNativeId,
    threadRef: null,
    replyMode: "reply",
  };
}

function resolveDeliveryHandle(request: DeliveryRequest): DeliveryHandle {
  if (request.deliveryHandle) {
    return request.deliveryHandle;
  }
  if (!request.provider || !request.surface || !request.targetRef) {
    throw new Error("delivery requires either deliveryHandle or provider/surface/targetRef");
  }
  return {
    provider: request.provider,
    surface: request.surface,
    targetRef: request.targetRef,
    threadRef: request.threadRef ?? null,
    replyMode: request.replyMode ?? null,
  };
}

export class ActivationDispatcher {
  async dispatch(target: string | null | undefined, activation: Activation): Promise<void> {
    if (!target) {
      return;
    }
    try {
      const response = await fetch(target, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(activation),
      });
      if (!response.ok) {
        console.warn(`activation dispatch failed for ${target}: ${response.status}`);
      }
    } catch (error) {
      console.warn(`activation dispatch error for ${target}:`, error);
    }
  }
}
