#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { AdapterRegistry } from "./adapters";
import { AgentInboxClient } from "./client";
import { startControlServer } from "./control_server";
import { AgentWithTargets, annotateAgents, BindingKind, resolveCurrentAgent } from "./current_agent";
import { daemonStatus, ensureDaemonForClient, removePidFile, startDaemon, stopDaemon, writePidFile } from "./daemon";
import { createServer } from "./http";
import { resolveDaemonPaths, resolveServeConfig } from "./paths";
import { AgentInboxService } from "./service";
import { AgentInboxStore } from "./store";
import { detectTerminalContext } from "./terminal";
import { jsonResponse, parseJsonArg } from "./util";

interface CommandWarning {
  code: "cross_session_agent";
  message: string;
  currentAgentId: string;
  requestedAgentId: string;
}

interface AgentSelection {
  agentId: string;
  autoRegistered: boolean;
  warnings: CommandWarning[];
}

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
    await printRemote(client, "/sources", {
      sourceType: type,
      sourceKey,
      configRef: takeFlagValue(normalized, "--config-ref") ?? undefined,
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

  if (command === "source" && normalized[1] === "remove") {
    const sourceId = normalized[2];
    if (!sourceId) {
      throw new Error("usage: agentinbox source remove <sourceId>");
    }
    await printRemote(client, `/sources/${encodeURIComponent(sourceId)}`, undefined, "DELETE");
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
    await printRemote(client, "/agents", {
      agentId: takeFlagValue(normalized, "--agent-id") ?? undefined,
      forceRebind: normalized.includes("--force-rebind"),
      backend: detected.backend,
      runtimeKind: detected.runtimeKind,
      runtimeSessionId: detected.runtimeSessionId ?? undefined,
      tmuxPaneId: detected.tmuxPaneId ?? undefined,
      tty: detected.tty ?? undefined,
      termProgram: detected.termProgram ?? undefined,
      itermSessionId: detected.itermSessionId ?? undefined,
      notifyLeaseMs: parseOptionalNumber(takeFlagValue(normalized, "--notify-lease-ms")) ?? undefined,
    });
    return;
  }

  if (command === "agent" && normalized[1] === "list") {
    await printAgentList(client);
    return;
  }

  if (command === "agent" && normalized[1] === "current") {
    await printCurrentAgent(client);
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
      notifyLeaseMs: parseOptionalNumber(takeFlagValue(normalized, "--notify-lease-ms")) ?? undefined,
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
    const args = normalized.slice(2);
    const positionals = positionalArgs(args, ["--agent-id", "--filter-json", "--filter-file", "--start-policy", "--start-offset", "--start-time"]);
    const sourceId = positionals[0];
    if (!sourceId || positionals[1]) {
      throw new Error("usage: agentinbox subscription add <sourceId> [--agent-id ID] [--filter-json JSON | --filter-file PATH | --filter-stdin] [--start-policy POLICY] [--start-offset N] [--start-time ISO8601]");
    }
    const selection = await selectAgentForCommand(client, {
      explicitAgentId: takeFlagValue(normalized, "--agent-id"),
      autoRegister: true,
    });
    const response = await requestRemote<Record<string, unknown>>(client, "/subscriptions", {
      agentId: selection.agentId,
      sourceId,
      filter: readSubscriptionFilter(normalized),
      startPolicy: takeFlagValue(normalized, "--start-policy") ?? undefined,
      startOffset: parseOptionalNumber(takeFlagValue(normalized, "--start-offset")),
      startTime: takeFlagValue(normalized, "--start-time") ?? undefined,
    });
    console.log(jsonResponse(withCommandMetadata(response.data, selection)));
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

  if (command === "subscription" && normalized[1] === "remove") {
    const subscriptionId = normalized[2];
    if (!subscriptionId) {
      throw new Error("usage: agentinbox subscription remove <subscriptionId>");
    }
    await printRemote(client, `/subscriptions/${encodeURIComponent(subscriptionId)}`, undefined, "DELETE");
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
    const args = normalized.slice(2);
    if (positionalArgs(args, ["--agent-id", "--after-item"]).length > 0) {
      throw new Error("usage: agentinbox inbox read [--agent-id ID] [--after-item ID] [--include-acked]");
    }
    const selection = await selectAgentForCommand(client, {
      explicitAgentId: takeFlagValue(normalized, "--agent-id"),
      autoRegister: true,
    });
    const query = buildQuery({
      after_item_id: takeFlagValue(normalized, "--after-item"),
      include_acked: hasFlag(normalized, "--include-acked") ? "true" : undefined,
    });
    const response = await requestRemote<Record<string, unknown>>(client, `/agents/${encodeURIComponent(selection.agentId)}/inbox/items${query}`, undefined, "GET");
    console.log(jsonResponse(withCommandMetadata(response.data, selection)));
    return;
  }

  if (command === "inbox" && normalized[1] === "watch") {
    const args = normalized.slice(2);
    if (positionalArgs(args, ["--agent-id", "--after-item", "--heartbeat-ms"]).length > 0) {
      throw new Error("usage: agentinbox inbox watch [--agent-id ID] [--after-item ID] [--include-acked] [--heartbeat-ms N]");
    }
    const selection = await selectAgentForCommand(client, {
      explicitAgentId: takeFlagValue(normalized, "--agent-id"),
      autoRegister: true,
    });
    const metadata = withCommandMetadata({
      event: "watch_notice",
    }, selection);
    if (selection.autoRegistered || selection.warnings.length > 0) {
      console.log(jsonResponse(metadata));
    }
    for await (const event of client.watchInbox(selection.agentId, {
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
    const args = normalized.slice(2);
    const itemId = takeFlagValue(normalized, "--item");
    const throughItemId = takeFlagValue(normalized, "--through");
    const ackAll = hasFlag(normalized, "--all");
    const modeCount = Number(Boolean(itemId)) + Number(Boolean(throughItemId)) + Number(ackAll);
    if (positionalArgs(args, ["--agent-id", "--item", "--through"]).length > 0 || modeCount !== 1) {
      throw new Error("usage: agentinbox inbox ack [--agent-id ID] (--through <itemId> | --item <itemId> | --all)");
    }
    const selection = await selectAgentForCommand(client, {
      explicitAgentId: takeFlagValue(normalized, "--agent-id"),
      autoRegister: true,
    });
    const response = await requestRemote<Record<string, unknown>>(
      client,
      `/agents/${encodeURIComponent(selection.agentId)}/inbox/ack`,
      ackAll ? { all: true } : (throughItemId ? { throughItemId } : { itemIds: [itemId] }),
    );
    console.log(jsonResponse(withCommandMetadata(response.data, selection)));
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
      threadRef: takeFlagValue(normalized, "--thread") ?? undefined,
      replyMode: takeFlagValue(normalized, "--reply-mode") ?? undefined,
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
  const adapters = new AdapterRegistry(store, async (input) => service.appendSourceEvent(input), {
    homeDir: serveConfig.homeDir,
  });
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

async function printAgentList(client: AgentInboxClient): Promise<void> {
  const records = await listAgentsWithTargets(client);
  console.log(jsonResponse(annotateAgents(records, tryDetectTerminalContext())));
}

async function printCurrentAgent(client: AgentInboxClient): Promise<void> {
  const context = getRequiredTerminalContext();
  const records = await listAgentsWithTargets(client);
  const current = resolveCurrentAgent(records, context);
  if (!current) {
    throw new Error("no current agent is registered for this terminal/runtime context; run `agentinbox agent register`");
  }
  console.log(jsonResponse(current));
}

async function selectAgentForCommand(
  client: AgentInboxClient,
  options: {
    explicitAgentId?: string;
    autoRegister: boolean;
  },
): Promise<AgentSelection> {
  const records = await listAgentsWithTargets(client);
  const context = tryDetectTerminalContext();

  if (options.explicitAgentId) {
    const current = context ? resolveCurrentAgent(records, context) : null;
    const requested = records.find((entry) => entry.agent.agentId === options.explicitAgentId);
    const warnings: CommandWarning[] = [];
    if (current && requested && current.agentId !== requested.agent.agentId && current.bindingKind === "session_bound"
      && bindingKindForRecord(requested) === "session_bound") {
      warnings.push({
        code: "cross_session_agent",
        message: "Requested agent does not match the current terminal session.",
        currentAgentId: current.agentId,
        requestedAgentId: requested.agent.agentId,
      });
    }
    return {
      agentId: options.explicitAgentId,
      autoRegistered: false,
      warnings,
    };
  }

  const contextForCurrent = getRequiredTerminalContext();
  const current = resolveCurrentAgent(records, contextForCurrent);
  if (current) {
    return {
      agentId: current.agentId,
      autoRegistered: false,
      warnings: [],
    };
  }

  if (!options.autoRegister) {
    throw new Error("no current agent is registered for this terminal/runtime context; run `agentinbox agent register`");
  }

  await requestRemote(client, "/agents", {
    backend: contextForCurrent.backend,
    runtimeKind: contextForCurrent.runtimeKind,
    runtimeSessionId: contextForCurrent.runtimeSessionId ?? undefined,
    tmuxPaneId: contextForCurrent.tmuxPaneId ?? undefined,
    tty: contextForCurrent.tty ?? undefined,
    termProgram: contextForCurrent.termProgram ?? undefined,
    itermSessionId: contextForCurrent.itermSessionId ?? undefined,
    notifyLeaseMs: undefined,
  });
  const refreshed = await listAgentsWithTargets(client);
  const registered = resolveCurrentAgent(refreshed, contextForCurrent);
  if (!registered) {
    throw new Error("failed to resolve current agent after auto-register");
  }
  return {
    agentId: registered.agentId,
    autoRegistered: true,
    warnings: [],
  };
}

async function listAgentsWithTargets(client: AgentInboxClient): Promise<AgentWithTargets[]> {
  const response = await requestRemote<{ agents: AgentWithTargets[] }>(client, "/agents?include_targets=true", undefined, "GET");
  return response.data.agents;
}

async function printRemote(
  client: AgentInboxClient,
  endpoint: string,
  body?: unknown,
  method: "GET" | "POST" | "DELETE" = "POST",
): Promise<void> {
  const response = await requestRemote(client, endpoint, body, method);
  console.log(jsonResponse(response.data));
}

async function requestRemote<T = unknown>(
  client: AgentInboxClient,
  endpoint: string,
  body?: unknown,
  method: "GET" | "POST" | "DELETE" = "POST",
): Promise<{ data: T }> {
  const response = await client.request<T>(endpoint, body, method);
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(jsonResponse(response.data));
  }
  return { data: response.data };
}

function takeFlagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) {
    return undefined;
  }
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`flag ${flag} requires a value`);
  }
  return value;
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

function readSubscriptionFilter(args: string[]): Record<string, unknown> {
  const filterJson = takeFlagValue(args, "--filter-json");
  const filterFile = takeFlagValue(args, "--filter-file");
  const filterStdin = hasFlag(args, "--filter-stdin");
  const configured = [filterJson != null, filterFile != null, filterStdin].filter(Boolean).length;
  if (configured > 1) {
    throw new Error("subscription add accepts only one of --filter-json, --filter-file, or --filter-stdin");
  }
  if (filterJson != null) {
    return parseJsonArg(filterJson, "--filter-json");
  }
  if (filterFile != null) {
    return parseJsonArg(fs.readFileSync(filterFile, "utf8"), `filter file ${filterFile}`);
  }
  if (filterStdin) {
    const stdin = fs.readFileSync(0, "utf8");
    return parseJsonArg(stdin, "stdin filter");
  }
  return {};
}

function withCommandMetadata<T extends Record<string, unknown>>(data: T, selection: AgentSelection): T & {
  agentId: string;
  autoRegistered?: true;
  warnings?: CommandWarning[];
} {
  return {
    ...data,
    agentId: selection.agentId,
    ...(selection.autoRegistered ? { autoRegistered: true as const } : {}),
    ...(selection.warnings.length > 0 ? { warnings: selection.warnings } : {}),
  };
}

function getRequiredTerminalContext() {
  try {
    return detectTerminalContext(process.env);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`unable to resolve current agent: ${message}`);
  }
}

function tryDetectTerminalContext() {
  try {
    return detectTerminalContext(process.env);
  } catch {
    return null;
  }
}

function bindingKindForRecord(record: AgentWithTargets): BindingKind {
  return record.agent.status === "active" && record.activationTargets.some((target) => target.kind === "terminal" && target.status === "active")
    ? "session_bound"
    : "detached";
}

function positionalArgs(args: string[], flagsWithValues: string[]): string[] {
  const flags = new Set(flagsWithValues);
  const positionals: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (flags.has(token)) {
      index += 1;
      continue;
    }
    if (token.startsWith("--")) {
      continue;
    }
    positionals.push(token);
  }
  return positionals;
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
  deliver
  status
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
  agentinbox source remove <sourceId>
  agentinbox source schema <sourceType>
  agentinbox source poll <sourceId>
  agentinbox source event <sourceId> --native-id ID --event EVENT [--occurred-at ISO8601] [--metadata-json JSON] [--payload-json JSON]
`,
    agent: `agentinbox agent

Usage:
  agentinbox agent register [--agent-id ID] [--force-rebind] [--notify-lease-ms N]
  agentinbox agent list
  agentinbox agent current
  agentinbox agent show <agentId>
  agentinbox agent remove <agentId>
  agentinbox agent target add webhook <agentId> --url URL [--activation-mode MODE] [--notify-lease-ms N]
  agentinbox agent target list <agentId>
  agentinbox agent target remove <agentId> <targetId>
`,
    subscription: `agentinbox subscription

Usage:
  agentinbox subscription add <sourceId> [--agent-id ID] [--filter-json JSON | --filter-file PATH | --filter-stdin] [--start-policy POLICY] [--start-offset N] [--start-time ISO8601]
  agentinbox subscription list [--source-id ID] [--agent-id ID]
  agentinbox subscription show <subscriptionId>
  agentinbox subscription remove <subscriptionId>
  agentinbox subscription poll <subscriptionId>
  agentinbox subscription lag <subscriptionId>
  agentinbox subscription reset <subscriptionId> --start-policy latest|earliest|at_offset|at_time [--start-offset N] [--start-time ISO8601]
`,
    inbox: `agentinbox inbox

Usage:
  agentinbox inbox list
  agentinbox inbox show <agentId>
  agentinbox inbox read [--agent-id ID] [--after-item ID] [--include-acked]
  agentinbox inbox watch [--agent-id ID] [--after-item ID] [--include-acked] [--heartbeat-ms N]
  agentinbox inbox ack [--agent-id ID] (--through <itemId> | --item <itemId> | --all)
  agentinbox inbox compact <agentId>
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
