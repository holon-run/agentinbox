#!/usr/bin/env node
import path from "node:path";
import { AgentInboxStore } from "./store";
import { AgentInboxService } from "./service";
import { createServer } from "./http";
import { jsonResponse, parseJsonArg } from "./util";
import { AdapterRegistry } from "./adapters";

const DEFAULT_PORT = 4747;
const DEFAULT_URL = process.env.AGENTINBOX_URL ?? `http://127.0.0.1:${DEFAULT_PORT}`;
const DEFAULT_STATE_DIR = process.env.AGENTINBOX_STATE_DIR ?? path.join(process.cwd(), ".agentinbox");
const DEFAULT_DB_PATH = path.join(DEFAULT_STATE_DIR, "agentinbox.sqlite");

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

  if (command === "source" && args[1] === "add") {
    const [type, sourceKey] = args.slice(2, 4);
    if (!type || !sourceKey) {
      throw new Error("usage: agentinbox source add <type> <sourceKey> [--config-json JSON] [--config-ref REF]");
    }
    const configJson = takeFlagValue(args, "--config-json");
    const configRef = takeFlagValue(args, "--config-ref");
    await printRemote("/sources/register", {
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
    await printRemote(`/sources/${encodeURIComponent(sourceId)}/poll`, {});
    return;
  }

  if (command === "interest" && args[1] === "add") {
    const [agentId, sourceId] = args.slice(2, 4);
    if (!agentId || !sourceId) {
      throw new Error("usage: agentinbox interest add <agentId> <sourceId> [--mailbox-id ID] [--match-json JSON] [--activation-target URL]");
    }
    await printRemote("/interests/register", {
      agentId,
      sourceId,
      mailboxId: takeFlagValue(args, "--mailbox-id") ?? undefined,
      matchRules: parseJsonArg(takeFlagValue(args, "--match-json")),
      activationTarget: takeFlagValue(args, "--activation-target") ?? null,
    });
    return;
  }

  if (command === "mailbox" && args[1] === "list") {
    await printRemote("/mailboxes", undefined, "GET");
    return;
  }

  if (command === "mailbox" && args[1] === "read") {
    const mailboxId = args[2];
    if (!mailboxId) {
      throw new Error("usage: agentinbox mailbox read <mailboxId>");
    }
    await printRemote(`/mailboxes/${encodeURIComponent(mailboxId)}/items`, undefined, "GET");
    return;
  }

  if (command === "mailbox" && args[1] === "ack") {
    const mailboxId = args[2];
    const itemId = takeFlagValue(args, "--item");
    if (!mailboxId || !itemId) {
      throw new Error("usage: agentinbox mailbox ack <mailboxId> --item <itemId>");
    }
    await printRemote(`/mailboxes/${encodeURIComponent(mailboxId)}/ack`, { itemIds: [itemId] });
    return;
  }

  if (command === "fixture" && args[1] === "emit") {
    const sourceId = args[2];
    const sourceNativeId = takeFlagValue(args, "--native-id") ?? `fixture-${Date.now()}`;
    const eventVariant = takeFlagValue(args, "--event") ?? "message";
    if (!sourceId) {
      throw new Error("usage: agentinbox fixture emit <sourceId> [--native-id ID] [--event EVENT] [--metadata-json JSON] [--payload-json JSON]");
    }
    await printRemote("/fixtures/emit", {
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
    await printRemote("/deliveries/send", {
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
    await printRemote("/status", undefined, "GET");
    return;
  }

  throw new Error(`unknown command: ${args.join(" ")}`);
}

async function runServe(args: string[]): Promise<void> {
  const port = Number(takeFlagValue(args, "--port") ?? DEFAULT_PORT);
  const dbPath = takeFlagValue(args, "--state") ?? DEFAULT_DB_PATH;
  const store = await AgentInboxStore.open(dbPath);
  let service: AgentInboxService;
  const adapters = new AdapterRegistry(store, async (input) => service.emitItem(input));
  service = new AgentInboxService(store, adapters);
  const server = createServer(service);
  await adapters.start();
  server.listen(port, "127.0.0.1", () => {
    console.log(jsonResponse({
      ok: true,
      url: `http://127.0.0.1:${port}`,
      dbPath,
    }));
  });
  const shutdown = () => {
    server.close(() => {
      void adapters.stop();
      store.close();
      process.exit(0);
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function printRemote(endpoint: string, body?: unknown, method: "GET" | "POST" = "POST"): Promise<void> {
  const response = await fetch(`${DEFAULT_URL}${endpoint}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(jsonResponse(data));
  }
  console.log(jsonResponse(data));
}

function takeFlagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) {
    return undefined;
  }
  return args[index + 1];
}

function printHelp(): void {
  console.log(`agentinbox

Commands:
  agentinbox serve [--port 4747] [--state .agentinbox/agentinbox.sqlite]
  agentinbox source add <type> <sourceKey> [--config-json JSON] [--config-ref REF]
  agentinbox source poll <sourceId>
  agentinbox interest add <agentId> <sourceId> [--mailbox-id ID] [--match-json JSON] [--activation-target URL]
  agentinbox mailbox list
  agentinbox mailbox read <mailboxId>
  agentinbox mailbox ack <mailboxId> --item <itemId>
  agentinbox fixture emit <sourceId> [--native-id ID] [--event EVENT] [--metadata-json JSON] [--payload-json JSON]
  agentinbox deliver send --provider PROVIDER --surface SURFACE --target TARGET [--kind KIND] [--payload-json JSON]
  agentinbox status
`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
