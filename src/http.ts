import http from "node:http";
import { AgentInboxService } from "./service";
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

      if (req.method === "POST" && url.pathname === "/sources/register") {
        const source = await service.registerSource(await readJson(req) as never);
        send(res, 200, source);
        return;
      }

      const sourcePollMatch = url.pathname.match(/^\/sources\/([^/]+)\/poll$/);
      if (req.method === "POST" && sourcePollMatch) {
        const result = await service.pollSource(decodeURIComponent(sourcePollMatch[1]));
        send(res, 200, result);
        return;
      }

      if (req.method === "POST" && url.pathname === "/subscriptions/register") {
        const subscription = await service.registerSubscription(await readJson(req) as never);
        send(res, 200, subscription);
        return;
      }

      const subscriptionPollMatch = url.pathname.match(/^\/subscriptions\/([^/]+)\/poll$/);
      if (req.method === "POST" && subscriptionPollMatch) {
        const result = await service.pollSubscription(decodeURIComponent(subscriptionPollMatch[1]));
        send(res, 200, result);
        return;
      }

      if (req.method === "POST" && url.pathname === "/fixtures/emit") {
        const result = await service.appendSourceEvent(await readJson(req) as never);
        send(res, 200, result);
        return;
      }

      if (req.method === "GET" && url.pathname === "/inboxes") {
        send(res, 200, { inboxes: service.listInboxIds() });
        return;
      }

      const inboxMatch = url.pathname.match(/^\/inboxes\/([^/]+)\/items$/);
      if (req.method === "GET" && inboxMatch) {
        send(res, 200, { items: service.listInboxItems(decodeURIComponent(inboxMatch[1])) });
        return;
      }

      const inboxAckMatch = url.pathname.match(/^\/inboxes\/([^/]+)\/ack$/);
      if (req.method === "POST" && inboxAckMatch) {
        const body = await readJson(req);
        const itemIds = Array.isArray(body.itemIds) ? body.itemIds.map(String) : [];
        send(res, 200, service.ackInboxItems(decodeURIComponent(inboxAckMatch[1]), itemIds));
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
      send(res, 500, { error: message });
    }
  });
}
