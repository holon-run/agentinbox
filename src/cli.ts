#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { AdapterRegistry } from "./adapters";
import { AgentInboxClient } from "./client";
import { startControlServer } from "./control_server";
import { daemonStatus, ensureDaemonForClient, removePidFile, startDaemon, stopDaemon, writePidFile } from "./daemon";
import { createServer } from "./http";
import { resolveDaemonPaths, resolveServeConfig } from "./paths";
import { AgentInboxService } from "./service";
import { AgentInboxStore } from "./store";
import { detectTerminalContext } from "./terminal";
import { jsonResponse, parseJsonArg } from "./util";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const normalized = normalizeHelpArgs(args);
  const command = normalized[0];

  if (!command || command === "help" || command === "--help" || command === "-h") {
    printHelp(normalized.slice(1));
    return;
  }

  if (command === "version" || command === "--version" || command === "-v") {
    if (hasHelpFlag(normalized.slice(1))) {
      printHelp(["version"]);
      return;
    }
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

  if (command === "daemon") {
    if (hasHelpFlag(normalized.slice(1))) {
      printHelp(["daemon"]);
      return;
    }
    await runDaemon(normalized.slice(1));
    return;
  }

  const client = await createClient(normalized);

  if (command === "source" && normalized[1] === "add") {
    const [type, sourceKey] = normalized.slice(2, 4);
    if (!type || !sourceKey) {
      throw new Error("usage: agentinbox source add <type> <sourceKey> [--config-json JSON] [--config-ref REF]");
    }
    await printRemote(client, "/sources/register", {
      sourceType: type,
      sourceKey,
      configRef: takeFlagValue(normalized, "--config-ref") ?? null,
      config: parseJsonArg(takeFlagValue(normalized, "--config-json")),
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

  if (command === "source" && normalized[1] === "schema") {
    const sourceType = normalized[2];
    if (!sourceType) {
      throw new Error("usage: agentinbox source schema <sourceType>");
    }
    await printRemote(client, `/source-types/${encodeURIComponent(sourceType)}/schema`, undefined, "GET");
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

  if (command === "agent" && normalized[1] === "register") {
    const detected = detectTerminalContext(process.env);
    await printRemote(client, "/agents/register", {
      backend: detected.backend,
      runtimeKind: detected.runtimeKind,
      runtimeSessionId: detected.runtimeSessionId ?? null,
      tmuxPaneId: detected.tmuxPaneId ?? null,
      tty: detected.tty ?? null,
      termProgram: detected.termProgram ?? null,
      itermSessionId: detected.itermSessionId ?? null,
      notifyLeaseMs: parseOptionalNumber(takeFlagValue(normalized, "--notify-lease-ms")) ?? null,
    });
    return;
  }

  if (command === "agent" && normalized[1] === "list") {
    await printRemote(client, "/agents", undefined, "GET");
    return;
  }

  if (command === "agent" && normalized[1] === "show") {
    const agentId = normalized[2];
    if (!agentId) {
      throw new Error("usage: agentinbox agent show <agentId>");
    }
    await printRemote(client, `/agents/${encodeURIComponent(agentId)}`, undefined, "GET");
    return;
  }

  if (command === "agent" && normalized[1] === "remove") {
    const agentId = normalized[2];
    if (!agentId) {
      throw new Error("usage: agentinbox agent remove <agentId>");
    }
    await printRemote(client, `/agents/${encodeURIComponent(agentId)}`, undefined, "DELETE");
    return;
  }

  if (command === "agent" && normalized[1] === "target" && normalized[2] === "add" && normalized[3] === "webhook") {
    const agentId = normalized[4];
    const url = takeFlagValue(normalized, "--url");
    if (!agentId || !url) {
      throw new Error("usage: agentinbox agent target add webhook <agentId> --url URL [--activation-mode MODE] [--notify-lease-ms N]");
    }
    await printRemote(client, `/agents/${encodeURIComponent(agentId)}/targets`, {
      kind: "webhook",
      url,
      activationMode: takeFlagValue(normalized, "--activation-mode") ?? undefined,
      notifyLeaseMs: parseOptionalNumber(takeFlagValue(normalized, "--notify-lease-ms")) ?? null,
    });
    return;
  }

  if (command === "agent" && normalized[1] === "target" && normalized[2] === "list") {
    const agentId = normalized[3];
    if (!agentId) {
      throw new Error("usage: agentinbox agent target list <agentId>");
    }
    await printRemote(client, `/agents/${encodeURIComponent(agentId)}/targets`, undefined, "GET");
    return;
  }

  if (command === "agent" && normalized[1] === "target" && normalized[2] === "remove") {
    const [agentId, targetId] = normalized.slice(3, 5);
    if (!agentId || !targetId) {
      throw new Error("usage: agentinbox agent target remove <agentId> <targetId>");
    }
    await printRemote(client, `/agents/${encodeURIComponent(agentId)}/targets/${encodeURIComponent(targetId)}`, undefined, "DELETE");
    return;
  }

  if (command === "subscription" && normalized[1] === "add") {
    const [agentId, sourceId] = normalized.slice(2, 4);
    if (!agentId || !sourceId) {
      throw new Error("usage: agentinbox subscription add <agentId> <sourceId> [--filter-json JSON] [--start-policy POLICY] [--start-offset N] [--start-time ISO8601]");
    }
    await printRemote(client, "/subscriptions/register", {
      agentId,
      sourceId,
      filter: parseJsonArg(takeFlagValue(normalized, "--filter-json")),
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

  if (command === "inbox" && normalized[1] === "list") {
    await printRemote(client, "/agents", undefined, "GET");
    return;
  }

  if (command === "inbox" && normalized[1] === "show") {
    const agentId = normalized[2];
    if (!agentId) {
      throw new Error("usage: agentinbox inbox show <agentId>");
    }
    await printRemote(client, `/agents/${encodeURIComponent(agentId)}/inbox`, undefined, "GET");
    return;
  }

  if (command === "inbox" && normalized[1] === "read") {
    const agentId = normalized[2];
    if (!agentId) {
      throw new Error("usage: agentinbox inbox read <agentId>");
    }
    const query = buildQuery({
      after_item_id: takeFlagValue(normalized, "--after-item"),
      include_acked: hasFlag(normalized, "--include-acked") ? "true" : undefined,
    });
    await printRemote(client, `/agents/${encodeURIComponent(agentId)}/inbox/items${query}`, undefined, "GET");
    return;
  }

  if (command === "inbox" && normalized[1] === "watch") {
    const agentId = normalized[2];
    if (!agentId) {
      throw new Error("usage: agentinbox inbox watch <agentId> [--after-item ID] [--include-acked] [--heartbeat-ms N]");
    }
    for await (const event of client.watchInbox(agentId, {
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
    const agentId = normalized[2];
    const itemId = takeFlagValue(normalized, "--item");
    const throughItemId = takeFlagValue(normalized, "--through");
    const ackAll = hasFlag(normalized, "--all");
    const modeCount = Number(Boolean(itemId)) + Number(Boolean(throughItemId)) + Number(ackAll);
    if (!agentId || modeCount !== 1) {
      throw new Error("usage: agentinbox inbox ack <agentId> (--through <itemId> | --item <itemId> | --all)");
    }
    if (ackAll) {
      await printRemote(client, `/agents/${encodeURIComponent(agentId)}/inbox/ack-all`, {});
      return;
    }
    await printRemote(
      client,
      `/agents/${encodeURIComponent(agentId)}/inbox/ack`,
      throughItemId ? { throughItemId } : { itemIds: [itemId] },
    );
    return;
  }

  if (command === "inbox" && normalized[1] === "compact") {
    const agentId = normalized[2];
    if (!agentId) {
      throw new Error("usage: agentinbox inbox compact <agentId>");
    }
    await printRemote(client, `/agents/${encodeURIComponent(agentId)}/inbox/compact`, {});
    return;
  }

  if (command === "gc") {
    await printRemote(client, "/gc", {});
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

  if (command === "gc") {
    await printRemote(client, "/gc", {});
    return;
  }

  if (hasHelpFlag(normalized.slice(1))) {
    printHelp([command]);
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

  const store = await AgentInboxStore.open(serveConfig.dbPath);
  let service: AgentInboxService;
  const adapters = new AdapterRegistry(store, async (input) => service.appendSourceEvent(input));
  service = new AgentInboxService(store, adapters);
  const server = createServer(service);
  await adapters.start();
  await service.start();
  const controlServer = await startControlServer(server, serveConfig.transport);
  const daemonPaths = resolveDaemonPaths(process.env, takeFlagValue(args, "--home"));
  if (serveConfig.transport.kind === "socket") {
    writePidFile(daemonPaths.pidPath, process.pid);
  }
  console.log(jsonResponse({
    ok: true,
    homeDir: serveConfig.homeDir,
    dbPath: serveConfig.dbPath,
    ...controlServer.info,
  }));

  const shutdown = () => {
    void controlServer.close().finally(() => {
      void adapters.stop();
      void service.stop();
      store.close();
      if (serveConfig.transport.kind === "socket") {
        removePidFile(daemonPaths.pidPath);
      }
      process.exit(0);
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function runDaemon(args: string[]): Promise<void> {
  const action = args[0];
  const options = {
    env: process.env,
    homeDirOverride: takeFlagValue(args, "--home"),
    socketPathOverride: takeFlagValue(args, "--socket"),
    baseUrlOverride: takeFlagValue(args, "--url"),
  };

  if (action === "start") {
    const result = await startDaemon(options);
    console.log(jsonResponse(result));
    return;
  }
  if (action === "stop") {
    const result = await stopDaemon(options);
    console.log(jsonResponse(result));
    return;
  }
  if (action === "status") {
    const result = await daemonStatus(options);
    console.log(jsonResponse(result));
    return;
  }

  throw new Error("usage: agentinbox daemon <start|stop|status>");
}

async function createClient(args: string[]): Promise<AgentInboxClient> {
  const transport = await ensureDaemonForClient({
    env: process.env,
    homeDirOverride: takeFlagValue(args, "--home"),
    socketPathOverride: takeFlagValue(args, "--socket"),
    baseUrlOverride: takeFlagValue(args, "--url"),
    noAutoStart: hasFlag(args, "--no-auto-start"),
  });
  return new AgentInboxClient(transport);
}

async function printRemote(
  client: AgentInboxClient,
  endpoint: string,
  body?: unknown,
  method: "GET" | "POST" | "DELETE" = "POST",
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
  agentinbox --help, -h
  agentinbox --version, -v

Commands:
  serve
  daemon
  source
  agent
  subscription
  inbox
  gc
  fixture
  deliver
  status
  gc
  version
`,
    serve: `agentinbox serve

Usage:
  agentinbox serve [--home ~/.agentinbox] [--socket ~/.agentinbox/agentinbox.sock]
  agentinbox serve --port 4747 [--state ~/.agentinbox/agentinbox.sqlite]
`,
    daemon: `agentinbox daemon

Usage:
  agentinbox daemon start [--home ~/.agentinbox] [--socket ~/.agentinbox/agentinbox.sock]
  agentinbox daemon stop [--home ~/.agentinbox] [--socket ~/.agentinbox/agentinbox.sock]
  agentinbox daemon status [--home ~/.agentinbox] [--socket ~/.agentinbox/agentinbox.sock]
`,
    source: `agentinbox source

Usage:
  agentinbox source add <type> <sourceKey> [--config-json JSON] [--config-ref REF]
  agentinbox source list
  agentinbox source show <sourceId>
  agentinbox source schema <sourceType>
  agentinbox source poll <sourceId>
  agentinbox source event <sourceId> --native-id ID --event EVENT [--occurred-at ISO8601] [--metadata-json JSON] [--payload-json JSON]
`,
    agent: `agentinbox agent

Usage:
  agentinbox agent register [--notify-lease-ms N]
  agentinbox agent list
  agentinbox agent show <agentId>
  agentinbox agent remove <agentId>
  agentinbox agent target add webhook <agentId> --url URL [--activation-mode MODE] [--notify-lease-ms N]
  agentinbox agent target list <agentId>
  agentinbox agent target remove <agentId> <targetId>
`,
    subscription: `agentinbox subscription

Usage:
  agentinbox subscription add <agentId> <sourceId> [--filter-json JSON] [--start-policy POLICY] [--start-offset N] [--start-time ISO8601]
  agentinbox subscription list [--source-id ID] [--agent-id ID]
  agentinbox subscription show <subscriptionId>
  agentinbox subscription poll <subscriptionId>
  agentinbox subscription lag <subscriptionId>
  agentinbox subscription reset <subscriptionId> --start-policy latest|earliest|at_offset|at_time [--start-offset N] [--start-time ISO8601]
`,
    inbox: `agentinbox inbox

Usage:
  agentinbox inbox list
  agentinbox inbox show <agentId>
  agentinbox inbox read <agentId> [--after-item ID] [--include-acked]
  agentinbox inbox watch <agentId> [--after-item ID] [--include-acked] [--heartbeat-ms N]
  agentinbox inbox ack <agentId> (--through <itemId> | --item <itemId> | --all)
  agentinbox inbox compact <agentId>
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
    gc: `agentinbox gc

Usage:
  agentinbox gc
`,
    version: `agentinbox version

Usage:
  agentinbox version
  agentinbox --version, -v
`,
  };
  console.log(helpByKey[key] ?? helpByKey.root);
}

function printVersion(): void {
  console.log(`agentinbox ${readPackageVersion()}`);
}

function readPackageVersion(): string {
  const packageJsonPath = findPackageJsonPath(__dirname);
  const parsed = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as { version?: unknown };
  return typeof parsed.version === "string" ? parsed.version : "0.0.0";
}

function findPackageJsonPath(startDir: string): string {
  let currentDir = startDir;
  while (true) {
    const candidate = path.join(currentDir, "package.json");
    if (fs.existsSync(candidate)) {
      return candidate;
    }
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      throw new Error(`could not locate package.json from ${startDir}`);
    }
    currentDir = parentDir;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
