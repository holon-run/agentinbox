import http from "node:http";
import { AgentInboxService } from "./service";
import { asObject, jsonResponse } from "./util";
import { DeliveryHandle, WatchInboxOptions } from "./model";

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk));
  }
  const body = Buffer.concat(chunks).toString("utf8");
  if (!body) {
    return {};
  }
  return asObject(JSON.parse(body));
}

function send(res: http.ServerResponse, statusCode: number, data: unknown): void {
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(jsonResponse(data));
}

function sendSse(res: http.ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\n`);
  const payload = jsonResponse(data)
    .split("\n")
    .map((line) => `data: ${line}`)
    .join("\n");
  res.write(`${payload}\n\n`);
}

export function createServer(service: AgentInboxService): http.Server {
  return http.createServer(async (req, res) => {
    try {
      if (!req.url || !req.method) {
        send(res, 400, { error: "missing request metadata" });
        return;
      }
      const url = new URL(req.url, "http://127.0.0.1");

      if (req.method === "GET" && url.pathname === "/healthz") {
        send(res, 200, { ok: true });
        return;
      }

      if (req.method === "GET" && url.pathname === "/status") {
        send(res, 200, service.status());
        return;
      }

      if (req.method === "GET" && url.pathname === "/sources") {
        send(res, 200, { sources: service.listSources() });
        return;
      }

      if (req.method === "POST" && url.pathname === "/sources/register") {
        const source = await service.registerSource(await readJson(req) as never);
        send(res, 200, source);
        return;
      }

      const sourceMatch = url.pathname.match(/^\/sources\/([^/]+)$/);
      if (req.method === "GET" && sourceMatch) {
        send(res, 200, service.getSourceDetails(decodeURIComponent(sourceMatch[1])));
        return;
      }

      const sourcePollMatch = url.pathname.match(/^\/sources\/([^/]+)\/poll$/);
      if (req.method === "POST" && sourcePollMatch) {
        const result = await service.pollSource(decodeURIComponent(sourcePollMatch[1]));
        send(res, 200, result);
        return;
      }

      const sourceEventsMatch = url.pathname.match(/^\/sources\/([^/]+)\/events$/);
      if (req.method === "POST" && sourceEventsMatch) {
        const sourceId = decodeURIComponent(sourceEventsMatch[1]);
        const body = await readJson(req);
        const sourceNativeId = parseRequiredString(body.sourceNativeId, "sources/events requires sourceNativeId");
        const eventVariant = parseRequiredString(body.eventVariant, "sources/events requires eventVariant");
        if (!sourceNativeId) {
          send(res, 400, { error: "sources/events requires sourceNativeId" });
          return;
        }
        if (!eventVariant) {
          send(res, 400, { error: "sources/events requires eventVariant" });
          return;
        }
        const result = await service.appendSourceEventByCaller(sourceId, {
          sourceNativeId,
          eventVariant,
          occurredAt: parseOptionalString(body.occurredAt),
          metadata: asObject(body.metadata),
          rawPayload: asObject(body.rawPayload),
          deliveryHandle: parseOptionalDeliveryHandle(body.deliveryHandle),
        });
        send(res, 200, result);
        return;
      }

      if (req.method === "GET" && url.pathname === "/subscriptions") {
        send(res, 200, {
          subscriptions: service.listSubscriptions({
            sourceId: url.searchParams.get("source_id") ?? undefined,
            agentId: url.searchParams.get("agent_id") ?? undefined,
            inboxId: url.searchParams.get("inbox_id") ?? undefined,
          }),
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/subscriptions/register") {
        const subscription = await service.registerSubscription(await readJson(req) as never);
        send(res, 200, subscription);
        return;
      }

      const subscriptionMatch = url.pathname.match(/^\/subscriptions\/([^/]+)$/);
      if (req.method === "GET" && subscriptionMatch) {
        send(res, 200, await service.getSubscriptionDetails(decodeURIComponent(subscriptionMatch[1])));
        return;
      }

      const subscriptionPollMatch = url.pathname.match(/^\/subscriptions\/([^/]+)\/poll$/);
      if (req.method === "POST" && subscriptionPollMatch) {
        const result = await service.pollSubscription(decodeURIComponent(subscriptionPollMatch[1]));
        send(res, 200, result);
        return;
      }

      const subscriptionLagMatch = url.pathname.match(/^\/subscriptions\/([^/]+)\/lag$/);
      if (req.method === "GET" && subscriptionLagMatch) {
        send(res, 200, await service.getSubscriptionLag(decodeURIComponent(subscriptionLagMatch[1])));
        return;
      }

      const subscriptionResetMatch = url.pathname.match(/^\/subscriptions\/([^/]+)\/reset$/);
      if (req.method === "POST" && subscriptionResetMatch) {
        const body = await readJson(req);
        const startPolicy = parseRequiredString(body.startPolicy, "subscriptions/reset requires startPolicy");
        send(res, 200, await service.resetSubscription({
          subscriptionId: decodeURIComponent(subscriptionResetMatch[1]),
          startPolicy: startPolicy as never,
          startOffset: parseOptionalInteger(body.startOffset),
          startTime: parseOptionalString(body.startTime) ?? null,
        }));
        return;
      }

      if (req.method === "POST" && url.pathname === "/fixtures/emit") {
        const body = await readJson(req);
        const sourceId = parseRequiredString(body.sourceId, "fixtures/emit requires sourceId");
        if (!sourceId) {
          send(res, 400, { error: "fixtures/emit requires sourceId" });
          return;
        }
        const sourceNativeId = parseRequiredString(body.sourceNativeId, "fixtures/emit requires sourceNativeId");
        if (!sourceNativeId) {
          send(res, 400, { error: "fixtures/emit requires sourceNativeId" });
          return;
        }
        const eventVariant = parseRequiredString(body.eventVariant, "fixtures/emit requires eventVariant");
        if (!eventVariant) {
          send(res, 400, { error: "fixtures/emit requires eventVariant" });
          return;
        }
        const result = await service.appendFixtureEvent(sourceId, {
          sourceNativeId,
          eventVariant,
          occurredAt: parseOptionalString(body.occurredAt),
          metadata: asObject(body.metadata),
          rawPayload: asObject(body.rawPayload),
          deliveryHandle: parseOptionalDeliveryHandle(body.deliveryHandle),
        });
        send(res, 200, result);
        return;
      }

      if (req.method === "GET" && url.pathname === "/inboxes") {
        send(res, 200, { inboxes: service.listInboxes() });
        return;
      }

      if (req.method === "POST" && url.pathname === "/inboxes/ensure") {
        const body = await readJson(req);
        const inboxId = parseRequiredString(body.inboxId, "inboxes/ensure requires inboxId");
        const agentId = parseRequiredString(body.agentId, "inboxes/ensure requires agentId");
        if (!inboxId) {
          send(res, 400, { error: "inboxes/ensure requires inboxId" });
          return;
        }
        if (!agentId) {
          send(res, 400, { error: "inboxes/ensure requires agentId" });
          return;
        }
        send(res, 200, service.ensureInboxByCaller(inboxId, agentId));
        return;
      }

      const inboxShowMatch = url.pathname.match(/^\/inboxes\/([^/]+)$/);
      if (req.method === "GET" && inboxShowMatch) {
        send(res, 200, service.getInboxDetails(decodeURIComponent(inboxShowMatch[1])));
        return;
      }

      const inboxMatch = url.pathname.match(/^\/inboxes\/([^/]+)\/items$/);
      if (req.method === "GET" && inboxMatch) {
        send(res, 200, {
          items: service.listInboxItems(decodeURIComponent(inboxMatch[1]), {
            afterItemId: url.searchParams.get("after_item_id") ?? undefined,
            includeAcked: url.searchParams.has("include_acked")
              ? url.searchParams.get("include_acked") === "true"
              : undefined,
          }),
        });
        return;
      }

      const inboxWatchMatch = url.pathname.match(/^\/inboxes\/([^/]+)\/watch$/);
      if (req.method === "GET" && inboxWatchMatch) {
        const inboxId = decodeURIComponent(inboxWatchMatch[1]);
        const watchOptions: WatchInboxOptions = {
          afterItemId: url.searchParams.get("after_item_id") ?? undefined,
          includeAcked: url.searchParams.get("include_acked") === "true",
          heartbeatMs: parsePositiveInteger(url.searchParams.get("heartbeat_ms")) ?? 15_000,
        };
        const session = service.watchInbox(inboxId, watchOptions, (event) => {
          sendSse(res, event.event, event);
        });

        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
        });
        res.flushHeaders?.();

        if (session.initialItems.length > 0) {
          sendSse(res, "items", {
            event: "items",
            inboxId,
            items: session.initialItems,
          });
        }
        session.start();

        const heartbeat = setInterval(() => {
          sendSse(res, "heartbeat", {
            event: "heartbeat",
            inboxId,
            timestamp: new Date().toISOString(),
          });
        }, watchOptions.heartbeatMs ?? 15_000);

        const cleanup = () => {
          clearInterval(heartbeat);
          session.close();
        };
        req.on("close", cleanup);
        req.on("error", cleanup);
        return;
      }

      const inboxAckMatch = url.pathname.match(/^\/inboxes\/([^/]+)\/ack$/);
      if (req.method === "POST" && inboxAckMatch) {
        const body = await readJson(req);
        const itemIds = Array.isArray(body.itemIds) ? body.itemIds.map(String) : [];
        send(res, 200, service.ackInboxItems(decodeURIComponent(inboxAckMatch[1]), itemIds));
        return;
      }

      const inboxAckAllMatch = url.pathname.match(/^\/inboxes\/([^/]+)\/ack-all$/);
      if (req.method === "POST" && inboxAckAllMatch) {
        send(res, 200, service.ackAllInboxItems(decodeURIComponent(inboxAckAllMatch[1])));
        return;
      }

      if (req.method === "POST" && url.pathname === "/deliveries/send") {
        const result = await service.sendDelivery(await readJson(req) as never);
        send(res, 200, result);
        return;
      }

      send(res, 404, { error: "not found" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.startsWith("unknown ")) {
        send(res, 404, { error: message });
        return;
      }
      if (
        message.startsWith("manual append is not supported") ||
        message.startsWith("fixtures/emit requires") ||
        message.startsWith("sources/events requires") ||
        message.startsWith("deliveryHandle requires") ||
        message.startsWith("subscriptions/reset requires") ||
        message.startsWith("inboxes/ensure requires") ||
        message.startsWith("inbox ") ||
        message.startsWith("unsupported start policy")
      ) {
        send(res, 400, { error: message });
        return;
      }
      if (message.startsWith("expected positive integer") || message.startsWith("expected integer")) {
        send(res, 400, { error: message });
        return;
      }
      send(res, 500, { error: message });
    }
  });
}

function parsePositiveInteger(value: string | null): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`expected positive integer, received ${value}`);
  }
  return parsed;
}

function parseOptionalInteger(value: unknown): number | undefined {
  if (value == null) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`expected integer, received ${String(value)}`);
  }
  return value;
}

function parseRequiredString(value: unknown, _errorMessage: string): string {
  if (typeof value !== "string") {
    return "";
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : "";
}

function parseOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseOptionalDeliveryHandle(value: unknown): DeliveryHandle | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const provider = parseOptionalString(record.provider);
  const surface = parseOptionalString(record.surface);
  const targetRef = parseOptionalString(record.targetRef);
  if (!provider || !surface || !targetRef) {
    throw new Error("deliveryHandle requires provider, surface, and targetRef");
  }
  return {
    provider,
    surface,
    targetRef,
    threadRef: parseOptionalString(record.threadRef) ?? null,
    replyMode: parseOptionalString(record.replyMode) ?? null,
  };
}
