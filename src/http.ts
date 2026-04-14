import http from "node:http";
import Fastify from "fastify";
import swagger from "@fastify/swagger";
import { summarizeActivationTarget } from "./current_agent";
import { AgentInboxService } from "./service";
import { ActivationMode, DeliveryHandle, WatchInboxOptions } from "./model";
import { jsonResponse } from "./util";

function sendSse(res: http.ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\n`);
  const payload = jsonResponse(data)
    .split("\n")
    .map((line) => `data: ${line}`)
    .join("\n");
  res.write(`${payload}\n\n`);
}

const jsonObjectSchema = {
  type: "object",
  additionalProperties: true,
} as const;

const errorResponseSchema = {
  type: "object",
  required: ["error"],
  additionalProperties: false,
  properties: {
    error: { type: "string" },
  },
} as const;

const deliveryHandleSchema = {
  type: "object",
  additionalProperties: false,
  required: ["provider", "surface", "targetRef"],
  properties: {
    provider: { type: "string", minLength: 1 },
    surface: { type: "string", minLength: 1 },
    targetRef: { type: "string", minLength: 1 },
    threadRef: { type: "string" },
    replyMode: { type: "string" },
  },
} as const;

function buildFastifyServer(service: AgentInboxService) {
  const app = Fastify({
    logger: false,
    ajv: {
      customOptions: {
        coerceTypes: false,
      },
    },
  });

  void app.register(swagger, {
    openapi: {
      info: {
        title: "AgentInbox Control Plane API",
        version: "0.1.0",
      },
    },
  });

  app.get("/healthz", {
    schema: {
      tags: ["system"],
      response: {
        200: {
          type: "object",
          required: ["ok"],
          properties: {
            ok: { type: "boolean" },
          },
        },
      },
    },
  }, async () => ({ ok: true }));

  app.get("/status", {
    schema: {
      tags: ["system"],
      response: {
        200: jsonObjectSchema,
      },
    },
  }, async () => service.status());

  app.get("/openapi.json", {
    schema: {
      tags: ["system"],
      response: {
        200: jsonObjectSchema,
      },
    },
  }, async () => app.swagger());

  app.post("/gc", {
    schema: {
      tags: ["inbox"],
      response: {
        200: jsonObjectSchema,
      },
    },
  }, async () => service.gc());

  app.get("/sources", {
    schema: {
      tags: ["sources"],
      response: {
        200: {
          type: "object",
          required: ["sources"],
          properties: {
            sources: { type: "array", items: jsonObjectSchema },
          },
        },
      },
    },
  }, async () => ({ sources: service.listSources() }));

  app.post("/sources", {
    schema: {
      tags: ["sources"],
      body: {
        type: "object",
        additionalProperties: false,
        required: ["sourceType", "sourceKey"],
        properties: {
          sourceType: { type: "string", minLength: 1 },
          sourceKey: { type: "string", minLength: 1 },
          configRef: { anyOf: [{ type: "string" }, { type: "null" }] },
          config: jsonObjectSchema,
        },
      },
      response: {
        200: jsonObjectSchema,
        400: errorResponseSchema,
      },
    },
  }, async (request) => service.registerSource(request.body as never));

  app.get("/sources/:sourceId", {
    schema: {
      tags: ["sources"],
      params: {
        type: "object",
        required: ["sourceId"],
        properties: {
          sourceId: { type: "string", minLength: 1 },
        },
      },
      response: {
        200: jsonObjectSchema,
        404: errorResponseSchema,
      },
    },
  }, async (request) => {
    const params = request.params as { sourceId: string };
    return service.getSourceDetails(decodeURIComponent(params.sourceId));
  });

  app.get("/sources/:sourceId/schema", {
    schema: {
      tags: ["sources"],
      params: {
        type: "object",
        required: ["sourceId"],
        properties: {
          sourceId: { type: "string", minLength: 1 },
        },
      },
      response: {
        200: jsonObjectSchema,
        400: errorResponseSchema,
        404: errorResponseSchema,
      },
    },
  }, async (request) => {
    const params = request.params as { sourceId: string };
    return service.getResolvedSourceSchema(decodeURIComponent(params.sourceId));
  });

  app.delete("/sources/:sourceId", {
    schema: {
      tags: ["sources"],
      params: {
        type: "object",
        required: ["sourceId"],
        properties: {
          sourceId: { type: "string", minLength: 1 },
        },
      },
      response: {
        200: jsonObjectSchema,
        400: errorResponseSchema,
      },
    },
  }, async (request) => {
    const params = request.params as { sourceId: string };
    return service.removeSource(decodeURIComponent(params.sourceId));
  });

  app.patch("/sources/:sourceId", {
    schema: {
      tags: ["sources"],
      params: {
        type: "object",
        required: ["sourceId"],
        properties: {
          sourceId: { type: "string", minLength: 1 },
        },
      },
      body: {
        type: "object",
        additionalProperties: false,
        minProperties: 1,
        properties: {
          configRef: { anyOf: [{ type: "string" }, { type: "null" }] },
          config: jsonObjectSchema,
        },
      },
      response: {
        200: jsonObjectSchema,
        400: errorResponseSchema,
      },
    },
  }, async (request) => {
    const params = request.params as { sourceId: string };
    return service.updateSource(decodeURIComponent(params.sourceId), request.body as never);
  });

  app.post("/sources/:sourceId/pause", {
    schema: {
      tags: ["sources"],
      params: {
        type: "object",
        required: ["sourceId"],
        properties: {
          sourceId: { type: "string", minLength: 1 },
        },
      },
      response: {
        200: jsonObjectSchema,
      },
    },
  }, async (request) => {
    const params = request.params as { sourceId: string };
    return service.pauseSource(decodeURIComponent(params.sourceId));
  });

  app.post("/sources/:sourceId/resume", {
    schema: {
      tags: ["sources"],
      params: {
        type: "object",
        required: ["sourceId"],
        properties: {
          sourceId: { type: "string", minLength: 1 },
        },
      },
      response: {
        200: jsonObjectSchema,
      },
    },
  }, async (request) => {
    const params = request.params as { sourceId: string };
    return service.resumeSource(decodeURIComponent(params.sourceId));
  });

  app.get("/source-types/:sourceType/schema", {
    schema: {
      tags: ["sources"],
      params: {
        type: "object",
        required: ["sourceType"],
        properties: {
          sourceType: { type: "string", minLength: 1 },
        },
      },
      response: {
        200: jsonObjectSchema,
      },
    },
  }, async (request) => {
    const params = request.params as { sourceType: string };
    return service.getSourceSchema(decodeURIComponent(params.sourceType) as never);
  });

  app.post("/sources/:sourceId/poll", {
    schema: {
      tags: ["sources"],
      params: {
        type: "object",
        required: ["sourceId"],
        properties: {
          sourceId: { type: "string", minLength: 1 },
        },
      },
      response: {
        200: jsonObjectSchema,
      },
    },
  }, async (request) => {
    const params = request.params as { sourceId: string };
    return service.pollSource(decodeURIComponent(params.sourceId));
  });

  app.post("/sources/:sourceId/events", {
    schema: {
      tags: ["sources"],
      params: {
        type: "object",
        required: ["sourceId"],
        properties: {
          sourceId: { type: "string", minLength: 1 },
        },
      },
      body: {
        type: "object",
        additionalProperties: false,
        required: ["sourceNativeId", "eventVariant"],
        properties: {
          sourceNativeId: { type: "string", minLength: 1 },
          eventVariant: { type: "string", minLength: 1 },
          occurredAt: { type: "string", minLength: 1 },
          metadata: jsonObjectSchema,
          rawPayload: jsonObjectSchema,
          deliveryHandle: deliveryHandleSchema,
        },
      },
      response: {
        200: jsonObjectSchema,
        400: errorResponseSchema,
      },
    },
  }, async (request) => {
    const params = request.params as { sourceId: string };
    const body = request.body as {
      sourceNativeId: string;
      eventVariant: string;
      occurredAt?: string;
      metadata?: Record<string, unknown>;
      rawPayload?: Record<string, unknown>;
      deliveryHandle?: DeliveryHandle;
    };
    return service.appendSourceEventByCaller(decodeURIComponent(params.sourceId), {
      sourceNativeId: body.sourceNativeId,
      eventVariant: body.eventVariant,
      occurredAt: optionalString(body.occurredAt),
      metadata: body.metadata ?? {},
      rawPayload: body.rawPayload ?? {},
      deliveryHandle: body.deliveryHandle ?? null,
    });
  });

  app.get("/agents", {
    schema: {
      tags: ["agents"],
      querystring: {
        type: "object",
        additionalProperties: false,
        properties: {
          include_targets: { type: "string", enum: ["true", "false"] },
        },
      },
      response: {
        200: {
          type: "object",
          required: ["agents"],
          properties: {
            agents: { type: "array", items: jsonObjectSchema },
          },
        },
      },
    },
  }, async (request) => {
    const query = request.query as { include_targets?: "true" | "false" };
    const agents = service.listAgents();
    if (query.include_targets === "true") {
      const activationTargetsByAgentId = service.listActivationTargets().reduce((grouped, target) => {
        const targets = grouped.get(target.agentId);
        const summarized = summarizeActivationTarget(target);
        if (targets) {
          targets.push(summarized);
        } else {
          grouped.set(target.agentId, [summarized]);
        }
        return grouped;
      }, new Map<string, ReturnType<typeof summarizeActivationTarget>[]>());
      return {
        agents: agents.map((agent) => ({
          agent,
          activationTargets: activationTargetsByAgentId.get(agent.agentId) ?? [],
        })),
      };
    }
    return { agents };
  });

  app.post("/agents", {
    schema: {
      tags: ["agents"],
      body: {
        type: "object",
        additionalProperties: false,
        required: ["backend"],
        properties: {
          agentId: { type: "string" },
          forceRebind: { type: "boolean" },
          backend: { type: "string", minLength: 1 },
          runtimeKind: { type: "string" },
          runtimeSessionId: { type: "string" },
          tmuxPaneId: { type: "string" },
          tty: { type: "string" },
          termProgram: { type: "string" },
          itermSessionId: { type: "string" },
          notifyLeaseMs: { type: "integer", minimum: 1 },
        },
      },
      response: {
        200: jsonObjectSchema,
        400: errorResponseSchema,
      },
    },
  }, async (request) => {
    const body = request.body as Record<string, unknown>;
    return service.registerAgent({
      agentId: optionalString(body.agentId) ?? null,
      forceRebind: body.forceRebind === true,
      backend: String(body.backend) as never,
      runtimeKind: optionalString(body.runtimeKind) as never,
      runtimeSessionId: optionalString(body.runtimeSessionId),
      mode: "agent_prompt",
      tmuxPaneId: optionalString(body.tmuxPaneId),
      tty: optionalString(body.tty),
      termProgram: optionalString(body.termProgram),
      itermSessionId: optionalString(body.itermSessionId),
      notifyLeaseMs: typeof body.notifyLeaseMs === "number" ? body.notifyLeaseMs : null,
    });
  });

  app.get("/agents/:agentId", {
    schema: {
      tags: ["agents"],
      params: {
        type: "object",
        required: ["agentId"],
        properties: {
          agentId: { type: "string", minLength: 1 },
        },
      },
      response: {
        200: jsonObjectSchema,
        404: errorResponseSchema,
      },
    },
  }, async (request) => {
    const params = request.params as { agentId: string };
    return service.getAgentDetails(decodeURIComponent(params.agentId));
  });

  app.delete("/agents/:agentId", {
    schema: {
      tags: ["agents"],
      params: {
        type: "object",
        required: ["agentId"],
        properties: {
          agentId: { type: "string", minLength: 1 },
        },
      },
      response: {
        200: jsonObjectSchema,
        404: errorResponseSchema,
      },
    },
  }, async (request) => {
    const params = request.params as { agentId: string };
    return service.removeAgent(decodeURIComponent(params.agentId));
  });

  app.get("/agents/:agentId/targets", {
    schema: {
      tags: ["agents"],
      params: {
        type: "object",
        required: ["agentId"],
        properties: {
          agentId: { type: "string", minLength: 1 },
        },
      },
      response: {
        200: {
          type: "object",
          required: ["targets"],
          properties: {
            targets: { type: "array", items: jsonObjectSchema },
          },
        },
      },
    },
  }, async (request) => {
    const params = request.params as { agentId: string };
    return { targets: service.listActivationTargets(decodeURIComponent(params.agentId)) };
  });

  app.post("/agents/:agentId/targets", {
    schema: {
      tags: ["agents"],
      params: {
        type: "object",
        required: ["agentId"],
        properties: {
          agentId: { type: "string", minLength: 1 },
        },
      },
      body: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "url"],
        properties: {
          kind: { type: "string", enum: ["webhook"] },
          url: { type: "string", minLength: 1 },
          activationMode: { type: "string" },
          notifyLeaseMs: { type: "integer", minimum: 1 },
        },
      },
      response: {
        200: jsonObjectSchema,
        400: errorResponseSchema,
      },
    },
  }, async (request) => {
    const params = request.params as { agentId: string };
    const body = request.body as {
      url: string;
      activationMode?: ActivationMode;
      notifyLeaseMs?: number;
    };
    return service.addWebhookActivationTarget(decodeURIComponent(params.agentId), {
      url: body.url,
      activationMode: body.activationMode,
      notifyLeaseMs: body.notifyLeaseMs ?? null,
    });
  });

  app.delete("/agents/:agentId/targets/:targetId", {
    schema: {
      tags: ["agents"],
      params: {
        type: "object",
        required: ["agentId", "targetId"],
        properties: {
          agentId: { type: "string", minLength: 1 },
          targetId: { type: "string", minLength: 1 },
        },
      },
      response: {
        200: jsonObjectSchema,
      },
    },
  }, async (request) => {
    const params = request.params as { agentId: string; targetId: string };
    return service.removeActivationTarget(decodeURIComponent(params.agentId), decodeURIComponent(params.targetId));
  });

  app.get("/subscriptions", {
    schema: {
      tags: ["subscriptions"],
      querystring: {
        type: "object",
        additionalProperties: false,
        properties: {
          source_id: { type: "string" },
          agent_id: { type: "string" },
        },
      },
      response: {
        200: {
          type: "object",
          required: ["subscriptions"],
          properties: {
            subscriptions: { type: "array", items: jsonObjectSchema },
          },
        },
      },
    },
  }, async (request) => {
    const query = request.query as { source_id?: string; agent_id?: string };
    return {
      subscriptions: service.listSubscriptions({
        sourceId: query.source_id,
        agentId: query.agent_id,
      }),
    };
  });

  app.post("/subscriptions", {
    schema: {
      tags: ["subscriptions"],
      body: {
        type: "object",
        additionalProperties: false,
        required: ["agentId", "sourceId"],
        properties: {
          agentId: { type: "string", minLength: 1 },
          sourceId: { type: "string", minLength: 1 },
          filter: jsonObjectSchema,
          trackedResourceRef: { type: "string" },
          cleanupPolicy: jsonObjectSchema,
          startPolicy: { type: "string" },
          startOffset: { type: "integer" },
          startTime: { type: "string" },
        },
      },
      response: {
        200: jsonObjectSchema,
        400: errorResponseSchema,
      },
    },
  }, async (request) => {
    const body = request.body as Record<string, unknown>;
    return service.registerSubscription({
      agentId: String(body.agentId),
      sourceId: String(body.sourceId),
      filter: (body.filter as Record<string, unknown> | undefined) ?? {},
      trackedResourceRef: optionalString(body.trackedResourceRef) ?? null,
      cleanupPolicy: ((body.cleanupPolicy as Record<string, unknown> | undefined) ?? null) as never,
      startPolicy: optionalString(body.startPolicy) as never,
      startOffset: typeof body.startOffset === "number" ? body.startOffset : undefined,
      startTime: optionalString(body.startTime) ?? undefined,
    });
  });

  app.get("/subscriptions/:subscriptionId", {
    schema: {
      tags: ["subscriptions"],
      params: {
        type: "object",
        required: ["subscriptionId"],
        properties: {
          subscriptionId: { type: "string", minLength: 1 },
        },
      },
      response: {
        200: jsonObjectSchema,
        404: errorResponseSchema,
      },
    },
  }, async (request) => {
    const params = request.params as { subscriptionId: string };
    return service.getSubscriptionDetails(decodeURIComponent(params.subscriptionId));
  });

  app.delete("/subscriptions/:subscriptionId", {
    schema: {
      tags: ["subscriptions"],
      params: {
        type: "object",
        required: ["subscriptionId"],
        properties: {
          subscriptionId: { type: "string", minLength: 1 },
        },
      },
      response: {
        200: jsonObjectSchema,
        404: errorResponseSchema,
      },
    },
  }, async (request) => {
    const params = request.params as { subscriptionId: string };
    return service.removeSubscription(decodeURIComponent(params.subscriptionId));
  });

  app.post("/subscriptions/:subscriptionId/poll", {
    schema: {
      tags: ["subscriptions"],
      params: {
        type: "object",
        required: ["subscriptionId"],
        properties: {
          subscriptionId: { type: "string", minLength: 1 },
        },
      },
      response: {
        200: jsonObjectSchema,
      },
    },
  }, async (request) => {
    const params = request.params as { subscriptionId: string };
    return service.pollSubscription(decodeURIComponent(params.subscriptionId));
  });

  app.get("/subscriptions/:subscriptionId/lag", {
    schema: {
      tags: ["subscriptions"],
      params: {
        type: "object",
        required: ["subscriptionId"],
        properties: {
          subscriptionId: { type: "string", minLength: 1 },
        },
      },
      response: {
        200: jsonObjectSchema,
      },
    },
  }, async (request) => {
    const params = request.params as { subscriptionId: string };
    return service.getSubscriptionLag(decodeURIComponent(params.subscriptionId));
  });

  app.post("/subscriptions/:subscriptionId/reset", {
    schema: {
      tags: ["subscriptions"],
      params: {
        type: "object",
        required: ["subscriptionId"],
        properties: {
          subscriptionId: { type: "string", minLength: 1 },
        },
      },
      body: {
        type: "object",
        additionalProperties: false,
        required: ["startPolicy"],
        properties: {
          startPolicy: { type: "string", minLength: 1 },
          startOffset: { type: "integer" },
          startTime: { type: "string" },
        },
      },
      response: {
        200: jsonObjectSchema,
        400: errorResponseSchema,
      },
    },
  }, async (request) => {
    const params = request.params as { subscriptionId: string };
    const body = request.body as { startPolicy: string; startOffset?: number; startTime?: string };
    return service.resetSubscription({
      subscriptionId: decodeURIComponent(params.subscriptionId),
      startPolicy: body.startPolicy as never,
      startOffset: body.startOffset,
      startTime: body.startTime ?? null,
    });
  });

  app.get("/agents/:agentId/inbox", {
    schema: {
      tags: ["inbox"],
      params: {
        type: "object",
        required: ["agentId"],
        properties: {
          agentId: { type: "string", minLength: 1 },
        },
      },
      response: {
        200: jsonObjectSchema,
        404: errorResponseSchema,
      },
    },
  }, async (request) => {
    const params = request.params as { agentId: string };
    return service.getInboxDetailsByAgent(decodeURIComponent(params.agentId));
  });

  app.get("/agents/:agentId/inbox/items", {
    schema: {
      tags: ["inbox"],
      params: {
        type: "object",
        required: ["agentId"],
        properties: {
          agentId: { type: "string", minLength: 1 },
        },
      },
      querystring: {
        type: "object",
        additionalProperties: false,
        properties: {
          after_item_id: { type: "string" },
          include_acked: { type: "string", enum: ["true", "false"] },
        },
      },
      response: {
        200: {
          type: "object",
          required: ["items"],
          properties: {
            items: { type: "array", items: jsonObjectSchema },
          },
        },
      },
    },
  }, async (request) => {
    const params = request.params as { agentId: string };
    const query = request.query as { after_item_id?: string; include_acked?: "true" | "false" };
    return {
      items: service.listInboxItems(decodeURIComponent(params.agentId), {
        afterItemId: query.after_item_id,
        includeAcked: query.include_acked ? query.include_acked === "true" : undefined,
      }),
    };
  });

  app.get("/agents/:agentId/inbox/watch", {
    schema: {
      tags: ["inbox"],
      params: {
        type: "object",
        required: ["agentId"],
        properties: {
          agentId: { type: "string", minLength: 1 },
        },
      },
      querystring: {
        type: "object",
        additionalProperties: false,
        properties: {
          after_item_id: { type: "string" },
          include_acked: { type: "string", enum: ["true", "false"] },
          heartbeat_ms: { type: "string", pattern: "^[1-9][0-9]*$" },
        },
      },
      response: {
        200: { type: "string" },
      },
    },
  }, async (request, reply) => {
    const params = request.params as { agentId: string };
    const query = request.query as {
      after_item_id?: string;
      include_acked?: "true" | "false";
      heartbeat_ms?: string;
    };
    const agentId = decodeURIComponent(params.agentId);
    const watchOptions: WatchInboxOptions = {
      afterItemId: query.after_item_id,
      includeAcked: query.include_acked ? query.include_acked === "true" : undefined,
      heartbeatMs: query.heartbeat_ms ? Number(query.heartbeat_ms) : undefined,
    };

    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    });

    const session = service.watchInbox(agentId, watchOptions, (event) => {
      sendSse(raw, event.event, event);
    });
    sendSse(raw, "items", {
      event: "items",
      agentId,
      items: session.initialItems,
    });
    session.start();

    const heartbeatMs = watchOptions.heartbeatMs ?? 15_000;
    const heartbeat = setInterval(() => {
      sendSse(raw, "heartbeat", {
        event: "heartbeat",
        agentId,
        timestamp: new Date().toISOString(),
      });
    }, heartbeatMs);

    const cleanup = () => {
      clearInterval(heartbeat);
      session.close();
      raw.end();
    };
    request.raw.on("close", cleanup);
    request.raw.on("error", cleanup);
  });

  app.post("/agents/:agentId/inbox/compact", {
    schema: {
      tags: ["inbox"],
      params: {
        type: "object",
        required: ["agentId"],
        properties: {
          agentId: { type: "string", minLength: 1 },
        },
      },
      response: {
        200: jsonObjectSchema,
      },
    },
  }, async (request) => {
    const params = request.params as { agentId: string };
    return service.compactInbox(decodeURIComponent(params.agentId));
  });

  app.post("/agents/:agentId/inbox/ack", {
    schema: {
      tags: ["inbox"],
      params: {
        type: "object",
        required: ["agentId"],
        properties: {
          agentId: { type: "string", minLength: 1 },
        },
      },
      body: {
        oneOf: [
          {
            type: "object",
            additionalProperties: false,
            required: ["itemIds"],
            properties: {
              itemIds: {
                type: "array",
                minItems: 1,
                items: { type: "string", minLength: 1 },
              },
            },
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["throughItemId"],
            properties: {
              throughItemId: { type: "string", minLength: 1 },
            },
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["all"],
            properties: {
              all: { type: "boolean", const: true },
            },
          },
        ],
      },
      response: {
        200: jsonObjectSchema,
        400: errorResponseSchema,
      },
    },
  }, async (request) => {
    const params = request.params as { agentId: string };
    const body = request.body as {
      itemIds?: string[];
      throughItemId?: string;
      all?: boolean;
    };
    return service.ackInbox(decodeURIComponent(params.agentId), {
      itemIds: body.itemIds ?? [],
      throughItemId: body.throughItemId ?? null,
      all: body.all ?? false,
    });
  });

  app.post("/deliveries/send", {
    schema: {
      tags: ["deliveries"],
      body: {
        oneOf: [
          {
            type: "object",
            additionalProperties: false,
            required: ["kind", "payload", "deliveryHandle"],
            properties: {
              kind: { type: "string", minLength: 1 },
              payload: jsonObjectSchema,
              deliveryHandle: deliveryHandleSchema,
            },
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["kind", "payload", "provider", "surface", "targetRef"],
            properties: {
              kind: { type: "string", minLength: 1 },
              payload: jsonObjectSchema,
              provider: { type: "string", minLength: 1 },
              surface: { type: "string", minLength: 1 },
              targetRef: { type: "string", minLength: 1 },
              threadRef: { type: "string" },
              replyMode: { type: "string" },
            },
          },
        ],
      },
      response: {
        200: jsonObjectSchema,
        400: errorResponseSchema,
      },
    },
  }, async (request) => service.sendDelivery(request.body as never));

  app.setNotFoundHandler((_request, reply) => {
    void reply.code(404).send({ error: "not found" });
  });

  app.setErrorHandler((error, _request, reply) => {
    const message = error instanceof Error ? error.message : String(error);
    if ((error as { validation?: unknown }).validation) {
      void reply.code(400).send({ error: normalizeValidationMessage(message) });
      return;
    }
    if (message.startsWith("unknown ")) {
      void reply.code(404).send({ error: message });
      return;
    }
    if (isBadRequestError(message)) {
      void reply.code(400).send({ error: message });
      return;
    }
    void reply.code(500).send({ error: message });
  });

  return app;
}

export function createServer(service: AgentInboxService): http.Server {
  const app = buildFastifyServer(service);
  const ready = app.ready();
  const server = http.createServer((req, res) => {
    void Promise.resolve(ready)
      .then(() => {
        app.routing(req, res);
      })
      .catch((error: unknown) => {
        res.statusCode = 500;
        res.setHeader("content-type", "application/json; charset=utf-8");
        const message = error instanceof Error ? error.message : String(error);
        res.end(jsonResponse({ error: message }));
      });
  });

  const originalClose = server.close.bind(server);
  const wrappedClose: typeof server.close = ((callback?: (err?: Error) => void) => {
    return originalClose((closeError?: Error) => {
      void app
        .close()
        .then(() => callback?.(closeError))
        .catch((appCloseError) => {
          const normalized = appCloseError instanceof Error
            ? appCloseError
            : new Error(String(appCloseError));
          callback?.(closeError ?? normalized);
        });
    });
  }) as typeof server.close;
  server.close = wrappedClose;

  return server;
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeValidationMessage(message: string): string {
  if (message.includes("must be boolean")) {
    return "expected boolean";
  }
  if (message.includes("must be integer")) {
    return "expected integer";
  }
  if (message.includes("must be object")) {
    return "expected object";
  }
  return message;
}

function isBadRequestError(message: string): boolean {
  return (
    message.startsWith("manual append is not supported") ||
    message.startsWith("sources/events requires") ||
    message.startsWith("source remove requires") ||
    message.startsWith("deliveryHandle requires") ||
    message.startsWith("subscriptions/reset requires") ||
    message.startsWith("agents requires") ||
    message.startsWith("agents/targets requires") ||
    message.startsWith("subscriptions requires") ||
    message.startsWith("agent register conflict") ||
    message.startsWith("unsupported activation target kind") ||
    message.startsWith("unsupported cleanup policy mode") ||
    message.startsWith("unsupported start policy") ||
    message.startsWith("unsupported terminal") ||
    message.startsWith("cleanupPolicy ") ||
    message.startsWith("trackedResourceRef ") ||
    message.startsWith("expected boolean") ||
    message.startsWith("expected integer") ||
    message.startsWith("expected positive integer") ||
    message.startsWith("notifyLeaseMs must be a positive integer") ||
    message.startsWith("invalid webhook activation target") ||
    message.startsWith("remote_source requires") ||
    message.startsWith("remote_source profile") ||
    message.includes("requires tmuxPaneId") ||
    message.includes("requires iTerm2 session identity") ||
    message.includes("requires a supported terminal context") ||
    message.includes("belongs to agent")
  );
}
