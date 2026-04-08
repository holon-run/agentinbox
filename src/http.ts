import http from "node:http";
import { AgentInboxService } from "./service";
import { ActivationMode, DeliveryHandle, WatchInboxOptions } from "./model";
import { asObject, jsonResponse } from "./util";

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

      if (req.method === "POST" && url.pathname === "/gc") {
        send(res, 200, service.gc());
        return;
      }

      if (req.method === "GET" && url.pathname === "/sources") {
        send(res, 200, { sources: service.listSources() });
        return;
      }

      if (req.method === "POST" && url.pathname === "/sources/register") {
        send(res, 200, await service.registerSource(await readJson(req) as never));
        return;
      }

      const sourceMatch = url.pathname.match(/^\/sources\/([^/]+)$/);
      if (req.method === "GET" && sourceMatch) {
        send(res, 200, service.getSourceDetails(decodeURIComponent(sourceMatch[1])));
        return;
      }

      const sourceSchemaMatch = url.pathname.match(/^\/source-types\/([^/]+)\/schema$/);
      if (req.method === "GET" && sourceSchemaMatch) {
        send(res, 200, service.getSourceSchema(decodeURIComponent(sourceSchemaMatch[1]) as never));
        return;
      }

      const sourcePollMatch = url.pathname.match(/^\/sources\/([^/]+)\/poll$/);
      if (req.method === "POST" && sourcePollMatch) {
        send(res, 200, await service.pollSource(decodeURIComponent(sourcePollMatch[1])));
        return;
      }

      const sourceEventsMatch = url.pathname.match(/^\/sources\/([^/]+)\/events$/);
      if (req.method === "POST" && sourceEventsMatch) {
        const body = await readJson(req);
        const sourceId = decodeURIComponent(sourceEventsMatch[1]);
        const sourceNativeId = parseRequiredString(body.sourceNativeId, "sources/events requires sourceNativeId");
        const eventVariant = parseRequiredString(body.eventVariant, "sources/events requires eventVariant");
        send(res, 200, await service.appendSourceEventByCaller(sourceId, {
          sourceNativeId,
          eventVariant,
          occurredAt: parseOptionalString(body.occurredAt),
          metadata: asObject(body.metadata),
          rawPayload: asObject(body.rawPayload),
          deliveryHandle: parseOptionalDeliveryHandle(body.deliveryHandle),
        }));
        return;
      }

      if (req.method === "GET" && url.pathname === "/agents") {
        send(res, 200, { agents: service.listAgents() });
        return;
      }

      if (req.method === "POST" && url.pathname === "/agents/register") {
        const body = await readJson(req);
        const backend = parseRequiredString(body.backend, "agents/register requires backend");
        send(res, 200, service.registerAgent({
          agentId: parseOptionalString(body.agentId) ?? null,
          forceRebind: parseOptionalBoolean(body.forceRebind) ?? false,
          backend: backend as never,
          runtimeKind: parseOptionalString(body.runtimeKind) as never,
          runtimeSessionId: parseOptionalString(body.runtimeSessionId),
          mode: "agent_prompt",
          tmuxPaneId: parseOptionalString(body.tmuxPaneId),
          tty: parseOptionalString(body.tty),
          termProgram: parseOptionalString(body.termProgram),
          itermSessionId: parseOptionalString(body.itermSessionId),
          notifyLeaseMs: parseOptionalInteger(body.notifyLeaseMs) ?? null,
        }));
        return;
      }

      const agentMatch = url.pathname.match(/^\/agents\/([^/]+)$/);
      if (req.method === "GET" && agentMatch) {
        send(res, 200, service.getAgentDetails(decodeURIComponent(agentMatch[1])));
        return;
      }
      if (req.method === "DELETE" && agentMatch) {
        send(res, 200, service.removeAgent(decodeURIComponent(agentMatch[1])));
        return;
      }

      const agentTargetsMatch = url.pathname.match(/^\/agents\/([^/]+)\/targets$/);
      if (req.method === "GET" && agentTargetsMatch) {
        send(res, 200, {
          targets: service.listActivationTargets(decodeURIComponent(agentTargetsMatch[1])),
        });
        return;
      }

      if (req.method === "POST" && agentTargetsMatch) {
        const body = await readJson(req);
        const agentId = decodeURIComponent(agentTargetsMatch[1]);
        const kind = parseRequiredString(body.kind, "agents/targets requires kind");
        if (kind !== "webhook") {
          send(res, 400, { error: `unsupported activation target kind: ${kind}` });
          return;
        }
        const urlValue = parseRequiredString(body.url, "agents/targets requires url");
        send(res, 200, service.addWebhookActivationTarget(agentId, {
          url: urlValue,
          activationMode: parseOptionalString(body.activationMode) as ActivationMode | undefined,
          notifyLeaseMs: parseOptionalInteger(body.notifyLeaseMs) ?? null,
        }));
        return;
      }

      const agentTargetMatch = url.pathname.match(/^\/agents\/([^/]+)\/targets\/([^/]+)$/);
      if (req.method === "DELETE" && agentTargetMatch) {
        send(res, 200, service.removeActivationTarget(
          decodeURIComponent(agentTargetMatch[1]),
          decodeURIComponent(agentTargetMatch[2]),
        ));
        return;
      }

      if (req.method === "GET" && url.pathname === "/subscriptions") {
        send(res, 200, {
          subscriptions: service.listSubscriptions({
            sourceId: url.searchParams.get("source_id") ?? undefined,
            agentId: url.searchParams.get("agent_id") ?? undefined,
          }),
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/subscriptions/register") {
        const body = await readJson(req);
        send(res, 200, await service.registerSubscription({
          agentId: parseRequiredString(body.agentId, "subscriptions/register requires agentId"),
          sourceId: parseRequiredString(body.sourceId, "subscriptions/register requires sourceId"),
          filter: asObject(body.filter),
          lifecycleMode: parseOptionalString(body.lifecycleMode) as never,
          expiresAt: parseOptionalString(body.expiresAt) ?? null,
          startPolicy: parseOptionalString(body.startPolicy) as never,
          startOffset: parseOptionalInteger(body.startOffset),
          startTime: parseOptionalString(body.startTime) ?? undefined,
        }));
        return;
      }

      const subscriptionMatch = url.pathname.match(/^\/subscriptions\/([^/]+)$/);
      if (req.method === "GET" && subscriptionMatch) {
        send(res, 200, await service.getSubscriptionDetails(decodeURIComponent(subscriptionMatch[1])));
        return;
      }
      if (req.method === "DELETE" && subscriptionMatch) {
        send(res, 200, await service.removeSubscription(decodeURIComponent(subscriptionMatch[1])));
        return;
      }

      const subscriptionPollMatch = url.pathname.match(/^\/subscriptions\/([^/]+)\/poll$/);
      if (req.method === "POST" && subscriptionPollMatch) {
        send(res, 200, await service.pollSubscription(decodeURIComponent(subscriptionPollMatch[1])));
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
        const sourceNativeId = parseRequiredString(body.sourceNativeId, "fixtures/emit requires sourceNativeId");
        const eventVariant = parseRequiredString(body.eventVariant, "fixtures/emit requires eventVariant");
        send(res, 200, await service.appendFixtureEvent(sourceId, {
          sourceNativeId,
          eventVariant,
          occurredAt: parseOptionalString(body.occurredAt),
          metadata: asObject(body.metadata),
          rawPayload: asObject(body.rawPayload),
          deliveryHandle: parseOptionalDeliveryHandle(body.deliveryHandle),
        }));
        return;
      }

      const agentInboxMatch = url.pathname.match(/^\/agents\/([^/]+)\/inbox$/);
      if (req.method === "GET" && agentInboxMatch) {
        send(res, 200, service.getInboxDetailsByAgent(decodeURIComponent(agentInboxMatch[1])));
        return;
      }

      const agentInboxItemsMatch = url.pathname.match(/^\/agents\/([^/]+)\/inbox\/items$/);
      if (req.method === "GET" && agentInboxItemsMatch) {
        send(res, 200, {
          items: service.listInboxItems(decodeURIComponent(agentInboxItemsMatch[1]), {
            afterItemId: url.searchParams.get("after_item_id") ?? undefined,
            includeAcked: url.searchParams.has("include_acked")
              ? url.searchParams.get("include_acked") === "true"
              : undefined,
          }),
        });
        return;
      }

      const agentInboxWatchMatch = url.pathname.match(/^\/agents\/([^/]+)\/inbox\/watch$/);
      if (req.method === "GET" && agentInboxWatchMatch) {
        const agentId = decodeURIComponent(agentInboxWatchMatch[1]);
        const watchOptions: WatchInboxOptions = {
          afterItemId: url.searchParams.get("after_item_id") ?? undefined,
          includeAcked: url.searchParams.has("include_acked")
            ? url.searchParams.get("include_acked") === "true"
            : undefined,
          heartbeatMs: url.searchParams.has("heartbeat_ms")
            ? parsePositiveInteger(url.searchParams.get("heartbeat_ms"))
            : undefined,
        };

        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
        });

        const session = service.watchInbox(agentId, watchOptions, (event) => {
          sendSse(res, event.event, event);
        });
        sendSse(res, "items", {
          event: "items",
          agentId,
          items: session.initialItems,
        });
        session.start();

        const heartbeatMs = watchOptions.heartbeatMs ?? 15_000;
        const heartbeat = setInterval(() => {
          sendSse(res, "heartbeat", {
            event: "heartbeat",
            agentId,
            timestamp: new Date().toISOString(),
          });
        }, heartbeatMs);

        const cleanup = () => {
          clearInterval(heartbeat);
          session.close();
        };
        req.on("close", cleanup);
        req.on("error", cleanup);
        return;
      }

      const agentInboxAckAllMatch = url.pathname.match(/^\/agents\/([^/]+)\/inbox\/ack-all$/);
      if (req.method === "POST" && agentInboxAckAllMatch) {
        send(res, 200, service.ackAllInboxItems(decodeURIComponent(agentInboxAckAllMatch[1])));
        return;
      }

      const agentInboxCompactMatch = url.pathname.match(/^\/agents\/([^/]+)\/inbox\/compact$/);
      if (req.method === "POST" && agentInboxCompactMatch) {
        send(res, 200, service.compactInbox(decodeURIComponent(agentInboxCompactMatch[1])));
        return;
      }

      const agentInboxAckMatch = url.pathname.match(/^\/agents\/([^/]+)\/inbox\/ack$/);
      if (req.method === "POST" && agentInboxAckMatch) {
        const body = await readJson(req);
        const itemIds = Array.isArray(body.itemIds) ? body.itemIds.map((itemId) => String(itemId)) : [];
        const throughItemId = parseOptionalString(body.throughItemId);
        if (throughItemId && itemIds.length > 0) {
          send(res, 400, { error: "inbox/ack accepts either itemIds or throughItemId" });
          return;
        }
        if (throughItemId) {
          send(res, 200, service.ackInboxItemsThrough(decodeURIComponent(agentInboxAckMatch[1]), throughItemId));
          return;
        }
        send(res, 200, service.ackInboxItems(decodeURIComponent(agentInboxAckMatch[1]), itemIds));
        return;
      }

      if (req.method === "POST" && url.pathname === "/deliveries/send") {
        send(res, 200, await service.sendDelivery(await readJson(req) as never));
        return;
      }
      send(res, 404, { error: "not found" });
    } catch (error) {
      if (error instanceof SyntaxError) {
        send(res, 400, { error: error.message });
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      if (message.startsWith("unknown ")) {
        send(res, 404, { error: message });
        return;
      }
      if (isBadRequestError(message)) {
        send(res, 400, { error: message });
        return;
      }
      send(res, 500, { error: message });
    }
  });
}

function parseRequiredString(value: unknown, message: string): string {
  const parsed = parseOptionalString(value);
  if (!parsed) {
    throw new Error(message);
  }
  return parsed;
}

function parseOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseOptionalInteger(value: unknown): number | undefined {
  if (value == null) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    throw new Error(`expected integer, received ${String(value)}`);
  }
  return parsed;
}

function parseOptionalBoolean(value: unknown): boolean | undefined {
  if (value == null) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new Error(`expected boolean, received ${String(value)}`);
  }
  return value;
}

function parsePositiveInteger(value: unknown): number {
  const parsed = parseOptionalInteger(value);
  if (parsed == null || parsed <= 0) {
    throw new Error(`expected positive integer, received ${String(value)}`);
  }
  return parsed;
}

function isBadRequestError(message: string): boolean {
  return (
    message.startsWith("manual append is not supported") ||
    message.startsWith("fixtures/emit requires") ||
    message.startsWith("sources/events requires") ||
    message.startsWith("deliveryHandle requires") ||
    message.startsWith("subscriptions/reset requires") ||
    message.startsWith("agents/register requires") ||
    message.startsWith("agents/targets requires") ||
    message.startsWith("agent register conflict") ||
    message.startsWith("unsupported activation target kind") ||
    message.startsWith("unsupported lifecycle mode") ||
    message.startsWith("unsupported start policy") ||
    message.startsWith("unsupported terminal") ||
    message.startsWith("source type is reserved and not yet supported") ||
    message.startsWith("expected boolean") ||
    message.startsWith("expected integer") ||
    message.startsWith("expected positive integer") ||
    message.startsWith("notifyLeaseMs must be a positive integer") ||
    message.startsWith("invalid webhook activation target") ||
    message.includes("requires tmuxPaneId") ||
    message.includes("requires iTerm2 session identity") ||
    message.includes("requires a supported terminal context") ||
    message.includes("belongs to agent")
  );
}

function parseOptionalDeliveryHandle(value: unknown): DeliveryHandle | null {
  if (!value) {
    return null;
  }
  const object = asObject(value);
  const provider = parseRequiredString(object.provider, "deliveryHandle.provider is required");
  const surface = parseRequiredString(object.surface, "deliveryHandle.surface is required");
  const targetRef = parseRequiredString(object.targetRef, "deliveryHandle.targetRef is required");
  return {
    provider,
    surface,
    targetRef,
    threadRef: parseOptionalString(object.threadRef) ?? null,
    replyMode: parseOptionalString(object.replyMode) ?? null,
  };
}
