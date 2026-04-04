import { DeliveryAttempt, DeliveryRequest, SourceType, SubscriptionSource } from "./model";

export interface SourceAdapter {
  ensureSource(source: SubscriptionSource): Promise<void>;
}

export interface DeliveryAdapter {
  send(request: DeliveryRequest, attempt: DeliveryAttempt): Promise<{ status: DeliveryAttempt["status"]; note: string }>;
}

class NoopSourceAdapter implements SourceAdapter {
  async ensureSource(_source: SubscriptionSource): Promise<void> {
    return;
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

  async send(_request: DeliveryRequest, _attempt: DeliveryAttempt): Promise<{ status: "accepted"; note: string }> {
    return {
      status: "accepted",
      note: "provider adapter scaffolded; wire this to uxc in the next milestone",
    };
  }
}

export function sourceAdapterFor(type: SourceType): SourceAdapter {
  if (type === "fixture") {
    return new NoopSourceAdapter();
  }
  return new UxcBackedStubAdapter();
}

export function deliveryAdapterFor(provider: string): DeliveryAdapter {
  if (provider === "fixture") {
    return new NoopDeliveryAdapter();
  }
  return new UxcBackedStubAdapter();
}
