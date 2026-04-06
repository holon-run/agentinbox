#!/usr/bin/env node
import { AgentInboxStore } from "./store";
import { AgentInboxService } from "./service";
import { createServer } from "./http";
import { jsonResponse, parseJsonArg } from "./util";
import { AdapterRegistry } from "./adapters";
import { AgentInboxClient } from "./client";
import { startControlServer } from "./control_server";
import { resolveClientTransport, resolveServeConfig } from "./paths";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  if (command === "serve") {
    await runServe(args.slice(1));
    return;
  }

  const client = createClient(args);

  if (command === "source" && args[1] === "add") {
    const [type, sourceKey] = args.slice(2, 4);
    if (!type || !sourceKey) {
      throw new Error("usage: agentinbox source add <type> <sourceKey> [--config-json JSON] [--config-ref REF]");
    }
    const configJson = takeFlagValue(args, "--config-json");
    const configRef = takeFlagValue(args, "--config-ref");
    await printRemote(client, "/sources/register", {
      sourceType: type,
      sourceKey,
      configRef: configRef ?? null,
      config: parseJsonArg(configJson),
    });
    return;
  }

  if (command === "source" && args[1] === "poll") {
    const sourceId = args[2];
    if (!sourceId) {
      throw new Error("usage: agentinbox source poll <sourceId>");
    }
    await printRemote(client, `/sources/${encodeURIComponent(sourceId)}/poll`, {});
    return;
  }

  if (command === "source" && args[1] === "event") {
    const sourceId = args[2];
    const sourceNativeId = takeFlagValue(args, "--native-id");
    const eventVariant = takeFlagValue(args, "--event");
    if (!sourceId || !sourceNativeId || !eventVariant) {
      throw new Error("usage: agentinbox source event <sourceId> --native-id ID --event EVENT [--occurred-at ISO8601] [--metadata-json JSON] [--payload-json JSON]");
    }
    await printRemote(client, `/sources/${encodeURIComponent(sourceId)}/events`, {
      sourceNativeId,
      eventVariant,
      occurredAt: takeFlagValue(args, "--occurred-at") ?? undefined,
      metadata: parseJsonArg(takeFlagValue(args, "--metadata-json")),
      rawPayload: parseJsonArg(takeFlagValue(args, "--payload-json")),
    });
    return;
  }

  if (command === "subscription" && args[1] === "add") {
    const [agentId, sourceId] = args.slice(2, 4);
    if (!agentId || !sourceId) {
      throw new Error("usage: agentinbox subscription add <agentId> <sourceId> [--inbox-id ID] [--match-json JSON] [--activation-target URL] [--activation-mode MODE] [--start-policy POLICY] [--start-offset N] [--start-time ISO8601]");
    }
    await printRemote(client, "/subscriptions/register", {
      agentId,
      sourceId,
      inboxId: takeFlagValue(args, "--inbox-id") ?? undefined,
      matchRules: parseJsonArg(takeFlagValue(args, "--match-json")),
      activationTarget: takeFlagValue(args, "--activation-target") ?? null,
      activationMode: takeFlagValue(args, "--activation-mode") ?? undefined,
      startPolicy: takeFlagValue(args, "--start-policy") ?? undefined,
      startOffset: parseOptionalNumber(takeFlagValue(args, "--start-offset")),
      startTime: takeFlagValue(args, "--start-time") ?? undefined,
    });
    return;
  }

  if (command === "subscription" && args[1] === "poll") {
    const subscriptionId = args[2];
    if (!subscriptionId) {
      throw new Error("usage: agentinbox subscription poll <subscriptionId>");
    }
    await printRemote(client, `/subscriptions/${encodeURIComponent(subscriptionId)}/poll`, {});
    return;
  }

  if (command === "inbox" && args[1] === "list") {
    await printRemote(client, "/inboxes", undefined, "GET");
    return;
  }

  if (command === "inbox" && args[1] === "read") {
    const inboxId = args[2];
    if (!inboxId) {
      throw new Error("usage: agentinbox inbox read <inboxId>");
    }
    await printRemote(client, `/inboxes/${encodeURIComponent(inboxId)}/items`, undefined, "GET");
    return;
  }

  if (command === "inbox" && args[1] === "watch") {
    const inboxId = args[2];
    if (!inboxId) {
      throw new Error("usage: agentinbox inbox watch <inboxId> [--after-item ID] [--include-acked] [--heartbeat-ms N]");
    }
    for await (const event of client.watchInbox(inboxId, {
      afterItemId: takeFlagValue(args, "--after-item"),
      includeAcked: hasFlag(args, "--include-acked"),
      heartbeatMs: parseOptionalNumber(takeFlagValue(args, "--heartbeat-ms")),
    })) {
      if (event.event !== "items") {
        continue;
      }
      console.log(jsonResponse(event));
    }
    return;
  }

  if (command === "inbox" && args[1] === "ack") {
    const inboxId = args[2];
    const itemId = takeFlagValue(args, "--item");
    if (!inboxId || !itemId) {
      throw new Error("usage: agentinbox inbox ack <inboxId> --item <itemId>");
    }
    await printRemote(client, `/inboxes/${encodeURIComponent(inboxId)}/ack`, { itemIds: [itemId] });
    return;
  }

  if (command === "fixture" && args[1] === "emit") {
    const sourceId = args[2];
    const sourceNativeId = takeFlagValue(args, "--native-id") ?? `fixture-${Date.now()}`;
    const eventVariant = takeFlagValue(args, "--event") ?? "message";
    if (!sourceId) {
      throw new Error("usage: agentinbox fixture emit <sourceId> [--native-id ID] [--event EVENT] [--metadata-json JSON] [--payload-json JSON]");
    }
    await printRemote(client, "/fixtures/emit", {
      sourceId,
      sourceNativeId,
      eventVariant,
      metadata: parseJsonArg(takeFlagValue(args, "--metadata-json")),
      rawPayload: parseJsonArg(takeFlagValue(args, "--payload-json")),
    });
    return;
  }

  if (command === "deliver" && args[1] === "send") {
    const provider = takeFlagValue(args, "--provider");
    const surface = takeFlagValue(args, "--surface");
    const targetRef = takeFlagValue(args, "--target");
    const kind = takeFlagValue(args, "--kind") ?? "reply";
    if (!provider || !surface || !targetRef) {
      throw new Error("usage: agentinbox deliver send --provider PROVIDER --surface SURFACE --target TARGET [--kind KIND] [--payload-json JSON]");
    }
    await printRemote(client, "/deliveries/send", {
      provider,
      surface,
      targetRef,
      threadRef: takeFlagValue(args, "--thread") ?? null,
      replyMode: takeFlagValue(args, "--reply-mode") ?? null,
      kind,
      payload: parseJsonArg(takeFlagValue(args, "--payload-json")),
    });
    return;
  }

  if (command === "status") {
    await printRemote(client, "/status", undefined, "GET");
    return;
  }

  throw new Error(`unknown command: ${args.join(" ")}`);
}

async function runServe(args: string[]): Promise<void> {
  const port = parseOptionalNumber(takeFlagValue(args, "--port"));
  const serveConfig = resolveServeConfig({
    env: process.env,
    homeDirOverride: takeFlagValue(args, "--home"),
    statePathOverride: takeFlagValue(args, "--state"),
    socketPathOverride: takeFlagValue(args, "--socket"),
    portOverride: port,
  });

  const dbPath = serveConfig.dbPath;
  const store = await AgentInboxStore.open(dbPath);
  let service: AgentInboxService;
  const adapters = new AdapterRegistry(store, async (input) => service.appendSourceEvent(input));
  service = new AgentInboxService(store, adapters);
  const server = createServer(service);
  await adapters.start();
  await service.start();
  const controlServer = await startControlServer(server, serveConfig.transport);
  console.log(jsonResponse({
    ok: true,
    homeDir: serveConfig.homeDir,
    dbPath,
    ...controlServer.info,
  }));
  const shutdown = () => {
    void controlServer.close().finally(() => {
      void adapters.stop();
      void service.stop();
      store.close();
      process.exit(0);
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

function createClient(args: string[]): AgentInboxClient {
  const transport = resolveClientTransport({
    env: process.env,
    homeDirOverride: takeFlagValue(args, "--home"),
    socketPathOverride: takeFlagValue(args, "--socket"),
    baseUrlOverride: takeFlagValue(args, "--url"),
  });
  return new AgentInboxClient(transport);
}

async function printRemote(
  client: AgentInboxClient,
  endpoint: string,
  body?: unknown,
  method: "GET" | "POST" = "POST",
): Promise<void> {
  const response = await client.request(endpoint, body, method);
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(jsonResponse(response.data));
  }
  console.log(jsonResponse(response.data));
}

function takeFlagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) {
    return undefined;
  }
  return args[index + 1];
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function parseOptionalNumber(value: string | undefined): number | undefined {
  if (value == null) {
    return undefined;
  }
  const parsed = Number(value);
  if (Number.isNaN(parsed)) {
    throw new Error(`expected number, received ${value}`);
  }
  return parsed;
}

function printHelp(): void {
  console.log(`agentinbox

Commands:
  agentinbox serve [--home ~/.agentinbox] [--socket ~/.agentinbox/agentinbox.sock]
  agentinbox serve --port 4747 [--state ~/.agentinbox/agentinbox.sqlite]
  agentinbox source add <type> <sourceKey> [--config-json JSON] [--config-ref REF]
  agentinbox source poll <sourceId>
  agentinbox source event <sourceId> --native-id ID --event EVENT [--occurred-at ISO8601] [--metadata-json JSON] [--payload-json JSON]
  agentinbox subscription add <agentId> <sourceId> [--inbox-id ID] [--match-json JSON] [--activation-target URL] [--activation-mode MODE] [--start-policy POLICY] [--start-offset N] [--start-time ISO8601]
  agentinbox subscription poll <subscriptionId>
  agentinbox inbox list
  agentinbox inbox read <inboxId>
  agentinbox inbox watch <inboxId> [--after-item ID] [--include-acked] [--heartbeat-ms N]
  agentinbox inbox ack <inboxId> --item <itemId>
  agentinbox fixture emit <sourceId> [--native-id ID] [--event EVENT] [--metadata-json JSON] [--payload-json JSON]
  agentinbox deliver send --provider PROVIDER --surface SURFACE --target TARGET [--kind KIND] [--payload-json JSON]
  agentinbox status

Global client flags:
  --home PATH
  --socket PATH
  --url URL
`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
