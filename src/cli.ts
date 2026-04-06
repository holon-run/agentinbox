#!/usr/bin/env node
import pkg from "../package.json";
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
  const normalized = normalizeHelpArgs(args);
  const command = normalized[0];

  if (!command || command === "help" || command === "--help" || command === "-h") {
    printHelp(normalized.slice(1));
    return;
  }

  if (command === "version" || command === "--version" || command === "-v") {
    printVersion();
    return;
  }

  if (command === "serve") {
    if (hasHelpFlag(normalized.slice(1))) {
      printHelp(["serve"]);
      return;
    }
    await runServe(normalized.slice(1));
    return;
  }

  const client = createClient(normalized);

  if (command === "source" && hasHelpFlag(normalized.slice(1))) {
    printHelp(["source"]);
    return;
  }

  if (command === "source" && normalized[1] === "add") {
    const [type, sourceKey] = normalized.slice(2, 4);
    if (!type || !sourceKey) {
      throw new Error("usage: agentinbox source add <type> <sourceKey> [--config-json JSON] [--config-ref REF]");
    }
    const configJson = takeFlagValue(normalized, "--config-json");
    const configRef = takeFlagValue(normalized, "--config-ref");
    await printRemote(client, "/sources/register", {
      sourceType: type,
      sourceKey,
      configRef: configRef ?? null,
      config: parseJsonArg(configJson),
    });
    return;
  }

  if (command === "source" && normalized[1] === "list") {
    await printRemote(client, "/sources", undefined, "GET");
    return;
  }

  if (command === "source" && normalized[1] === "show") {
    const sourceId = normalized[2];
    if (!sourceId) {
      throw new Error("usage: agentinbox source show <sourceId>");
    }
    await printRemote(client, `/sources/${encodeURIComponent(sourceId)}`, undefined, "GET");
    return;
  }

  if (command === "source" && normalized[1] === "poll") {
    const sourceId = normalized[2];
    if (!sourceId) {
      throw new Error("usage: agentinbox source poll <sourceId>");
    }
    await printRemote(client, `/sources/${encodeURIComponent(sourceId)}/poll`, {});
    return;
  }

  if (command === "source" && normalized[1] === "event") {
    const sourceId = normalized[2];
    const sourceNativeId = takeFlagValue(normalized, "--native-id");
    const eventVariant = takeFlagValue(normalized, "--event");
    if (!sourceId || !sourceNativeId || !eventVariant) {
      throw new Error("usage: agentinbox source event <sourceId> --native-id ID --event EVENT [--occurred-at ISO8601] [--metadata-json JSON] [--payload-json JSON]");
    }
    await printRemote(client, `/sources/${encodeURIComponent(sourceId)}/events`, {
      sourceNativeId,
      eventVariant,
      occurredAt: takeFlagValue(normalized, "--occurred-at") ?? undefined,
      metadata: parseJsonArg(takeFlagValue(normalized, "--metadata-json")),
      rawPayload: parseJsonArg(takeFlagValue(normalized, "--payload-json")),
    });
    return;
  }

  if (command === "subscription" && hasHelpFlag(normalized.slice(1))) {
    printHelp(["subscription"]);
    return;
  }

  if (command === "subscription" && normalized[1] === "add") {
    const [agentId, sourceId] = normalized.slice(2, 4);
    if (!agentId || !sourceId) {
      throw new Error("usage: agentinbox subscription add <agentId> <sourceId> [--inbox-id ID] [--match-json JSON] [--activation-target URL] [--activation-mode MODE] [--start-policy POLICY] [--start-offset N] [--start-time ISO8601]");
    }
    await printRemote(client, "/subscriptions/register", {
      agentId,
      sourceId,
      inboxId: takeFlagValue(normalized, "--inbox-id") ?? undefined,
      matchRules: parseJsonArg(takeFlagValue(normalized, "--match-json")),
      activationTarget: takeFlagValue(normalized, "--activation-target") ?? null,
      activationMode: takeFlagValue(normalized, "--activation-mode") ?? undefined,
      startPolicy: takeFlagValue(normalized, "--start-policy") ?? undefined,
      startOffset: parseOptionalNumber(takeFlagValue(normalized, "--start-offset")),
      startTime: takeFlagValue(normalized, "--start-time") ?? undefined,
    });
    return;
  }

  if (command === "subscription" && normalized[1] === "list") {
    const query = buildQuery({
      source_id: takeFlagValue(normalized, "--source-id"),
      agent_id: takeFlagValue(normalized, "--agent-id"),
      inbox_id: takeFlagValue(normalized, "--inbox-id"),
    });
    await printRemote(client, `/subscriptions${query}`, undefined, "GET");
    return;
  }

  if (command === "subscription" && normalized[1] === "show") {
    const subscriptionId = normalized[2];
    if (!subscriptionId) {
      throw new Error("usage: agentinbox subscription show <subscriptionId>");
    }
    await printRemote(client, `/subscriptions/${encodeURIComponent(subscriptionId)}`, undefined, "GET");
    return;
  }

  if (command === "subscription" && normalized[1] === "poll") {
    const subscriptionId = normalized[2];
    if (!subscriptionId) {
      throw new Error("usage: agentinbox subscription poll <subscriptionId>");
    }
    await printRemote(client, `/subscriptions/${encodeURIComponent(subscriptionId)}/poll`, {});
    return;
  }

  if (command === "subscription" && normalized[1] === "lag") {
    const subscriptionId = normalized[2];
    if (!subscriptionId) {
      throw new Error("usage: agentinbox subscription lag <subscriptionId>");
    }
    await printRemote(client, `/subscriptions/${encodeURIComponent(subscriptionId)}/lag`, undefined, "GET");
    return;
  }

  if (command === "subscription" && normalized[1] === "reset") {
    const subscriptionId = normalized[2];
    const startPolicy = takeFlagValue(normalized, "--start-policy");
    if (!subscriptionId || !startPolicy) {
      throw new Error("usage: agentinbox subscription reset <subscriptionId> --start-policy latest|earliest|at_offset|at_time [--start-offset N] [--start-time ISO8601]");
    }
    await printRemote(client, `/subscriptions/${encodeURIComponent(subscriptionId)}/reset`, {
      startPolicy,
      startOffset: parseOptionalNumber(takeFlagValue(normalized, "--start-offset")),
      startTime: takeFlagValue(normalized, "--start-time") ?? undefined,
    });
    return;
  }

  if (command === "inbox" && hasHelpFlag(normalized.slice(1))) {
    printHelp(["inbox"]);
    return;
  }

  if (command === "inbox" && normalized[1] === "list") {
    await printRemote(client, "/inboxes", undefined, "GET");
    return;
  }

  if (command === "inbox" && normalized[1] === "ensure") {
    const inboxId = normalized[2];
    const agentId = takeFlagValue(normalized, "--agent-id");
    if (!inboxId || !agentId) {
      throw new Error("usage: agentinbox inbox ensure <inboxId> --agent-id <agentId>");
    }
    await printRemote(client, "/inboxes/ensure", { inboxId, agentId });
    return;
  }

  if (command === "inbox" && normalized[1] === "show") {
    const inboxId = normalized[2];
    if (!inboxId) {
      throw new Error("usage: agentinbox inbox show <inboxId>");
    }
    await printRemote(client, `/inboxes/${encodeURIComponent(inboxId)}`, undefined, "GET");
    return;
  }

  if (command === "inbox" && normalized[1] === "read") {
    const inboxId = normalized[2];
    if (!inboxId) {
      throw new Error("usage: agentinbox inbox read <inboxId>");
    }
    await printRemote(client, `/inboxes/${encodeURIComponent(inboxId)}/items`, undefined, "GET");
    return;
  }

  if (command === "inbox" && normalized[1] === "watch") {
    const inboxId = normalized[2];
    if (!inboxId) {
      throw new Error("usage: agentinbox inbox watch <inboxId> [--after-item ID] [--include-acked] [--heartbeat-ms N]");
    }
    for await (const event of client.watchInbox(inboxId, {
      afterItemId: takeFlagValue(normalized, "--after-item"),
      includeAcked: hasFlag(normalized, "--include-acked"),
      heartbeatMs: parseOptionalNumber(takeFlagValue(normalized, "--heartbeat-ms")),
    })) {
      if (event.event !== "items") {
        continue;
      }
      console.log(jsonResponse(event));
    }
    return;
  }

  if (command === "inbox" && normalized[1] === "ack") {
    const inboxId = normalized[2];
    const itemId = takeFlagValue(normalized, "--item");
    const ackAll = hasFlag(normalized, "--all");
    if (ackAll && itemId) {
      throw new Error("usage: agentinbox inbox ack <inboxId> (--item <itemId> | --all)");
    }
    if (!inboxId || (!itemId && !ackAll)) {
      throw new Error("usage: agentinbox inbox ack <inboxId> (--item <itemId> | --all)");
    }
    if (ackAll) {
      await printRemote(client, `/inboxes/${encodeURIComponent(inboxId)}/ack-all`, {});
      return;
    }
    await printRemote(client, `/inboxes/${encodeURIComponent(inboxId)}/ack`, { itemIds: [itemId] });
    return;
  }

  if (command === "fixture" && hasHelpFlag(normalized.slice(1))) {
    printHelp(["fixture"]);
    return;
  }

  if (command === "fixture" && normalized[1] === "emit") {
    const sourceId = normalized[2];
    const sourceNativeId = takeFlagValue(normalized, "--native-id") ?? `fixture-${Date.now()}`;
    const eventVariant = takeFlagValue(normalized, "--event") ?? "message";
    if (!sourceId) {
      throw new Error("usage: agentinbox fixture emit <sourceId> [--native-id ID] [--event EVENT] [--metadata-json JSON] [--payload-json JSON]");
    }
    await printRemote(client, "/fixtures/emit", {
      sourceId,
      sourceNativeId,
      eventVariant,
      metadata: parseJsonArg(takeFlagValue(normalized, "--metadata-json")),
      rawPayload: parseJsonArg(takeFlagValue(normalized, "--payload-json")),
    });
    return;
  }

  if (command === "deliver" && hasHelpFlag(normalized.slice(1))) {
    printHelp(["deliver"]);
    return;
  }

  if (command === "deliver" && normalized[1] === "send") {
    const provider = takeFlagValue(normalized, "--provider");
    const surface = takeFlagValue(normalized, "--surface");
    const targetRef = takeFlagValue(normalized, "--target");
    const kind = takeFlagValue(normalized, "--kind") ?? "reply";
    if (!provider || !surface || !targetRef) {
      throw new Error("usage: agentinbox deliver send --provider PROVIDER --surface SURFACE --target TARGET [--kind KIND] [--payload-json JSON]");
    }
    await printRemote(client, "/deliveries/send", {
      provider,
      surface,
      targetRef,
      threadRef: takeFlagValue(normalized, "--thread") ?? null,
      replyMode: takeFlagValue(normalized, "--reply-mode") ?? null,
      kind,
      payload: parseJsonArg(takeFlagValue(normalized, "--payload-json")),
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

function normalizeHelpArgs(args: string[]): string[] {
  if (args[0] !== "help") {
    return args;
  }
  if (!args[1]) {
    return ["help"];
  }
  return [args[1], "--help"];
}

function hasHelpFlag(args: string[]): boolean {
  return args.includes("--help") || args.includes("-h");
}

function buildQuery(params: Record<string, string | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value) {
      search.set(key, value);
    }
  }
  const query = search.toString();
  return query ? `?${query}` : "";
}

function printHelp(path: string[] = []): void {
  const key = path[0] ?? "root";
  const helpByKey: Record<string, string> = {
    root: `agentinbox

Usage:
  agentinbox <command> [options]
  agentinbox help [command]
  agentinbox --help
  agentinbox --version

Commands:
  serve
  source
  subscription
  inbox
  fixture
  deliver
  status
  version

Try:
  agentinbox <command> --help
`,
    serve: `agentinbox serve

Usage:
  agentinbox serve [--home ~/.agentinbox] [--socket ~/.agentinbox/agentinbox.sock]
  agentinbox serve --port 4747 [--state ~/.agentinbox/agentinbox.sqlite]
`,
    source: `agentinbox source

Usage:
  agentinbox source add <type> <sourceKey> [--config-json JSON] [--config-ref REF]
  agentinbox source list
  agentinbox source show <sourceId>
  agentinbox source poll <sourceId>
  agentinbox source event <sourceId> --native-id ID --event EVENT [--occurred-at ISO8601] [--metadata-json JSON] [--payload-json JSON]
`,
    subscription: `agentinbox subscription

Usage:
  agentinbox subscription add <agentId> <sourceId> [--inbox-id ID] [--match-json JSON] [--activation-target URL] [--activation-mode MODE] [--start-policy POLICY] [--start-offset N] [--start-time ISO8601]
  agentinbox subscription list [--source-id ID] [--agent-id ID] [--inbox-id ID]
  agentinbox subscription show <subscriptionId>
  agentinbox subscription poll <subscriptionId>
  agentinbox subscription lag <subscriptionId>
  agentinbox subscription reset <subscriptionId> --start-policy latest|earliest|at_offset|at_time [--start-offset N] [--start-time ISO8601]
`,
    inbox: `agentinbox inbox

Usage:
  agentinbox inbox list
  agentinbox inbox ensure <inboxId> --agent-id <agentId>
  agentinbox inbox show <inboxId>
  agentinbox inbox read <inboxId>
  agentinbox inbox watch <inboxId> [--after-item ID] [--include-acked] [--heartbeat-ms N]
  agentinbox inbox ack <inboxId> (--item <itemId> | --all)
`,
    fixture: `agentinbox fixture

Usage:
  agentinbox fixture emit <sourceId> [--native-id ID] [--event EVENT] [--metadata-json JSON] [--payload-json JSON]
`,
    deliver: `agentinbox deliver

Usage:
  agentinbox deliver send --provider PROVIDER --surface SURFACE --target TARGET [--kind KIND] [--payload-json JSON]
`,
    status: `agentinbox status

Usage:
  agentinbox status
`,
    version: `agentinbox version

Usage:
  agentinbox version
  agentinbox --version
`,
  };
  console.log(helpByKey[key] ?? helpByKey.root);
}

function printVersion(): void {
  console.log(`agentinbox ${pkg.version}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
