import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { AgentInboxStore } from "../src/store";
import { AgentInboxService } from "../src/service";
import { AdapterRegistry } from "../src/adapters";
import { createServer } from "../src/http";
import { AgentInboxClient } from "../src/client";
import { startControlServer } from "../src/control_server";
import { DEFAULT_AGENTINBOX_PORT, resolveClientTransport, resolveServeConfig } from "../src/paths";

test("resolveServeConfig derives home, db, and socket defaults from AGENTINBOX_HOME", () => {
  const homeDir = path.join(os.tmpdir(), `agentinbox-home-${Date.now()}`);
  const config = resolveServeConfig({
    env: {
      ...process.env,
      AGENTINBOX_HOME: homeDir,
    },
  });

  assert.equal(config.homeDir, homeDir);
  assert.equal(config.dbPath, path.join(homeDir, "agentinbox.sqlite"));
  assert.deepEqual(config.transport, {
    kind: "socket",
    socketPath: path.join(homeDir, "agentinbox.sock"),
  });
});

test("resolveClientTransport prefers the default socket and otherwise falls back to localhost tcp", () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentinbox-client-home-"));
  try {
    const withoutSocket = resolveClientTransport({
      env: {
        ...process.env,
        AGENTINBOX_HOME: homeDir,
      },
    });
    assert.deepEqual(withoutSocket, {
      kind: "url",
      baseUrl: `http://127.0.0.1:${DEFAULT_AGENTINBOX_PORT}`,
      source: "fallback",
    });

    const socketPath = path.join(homeDir, "agentinbox.sock");
    fs.writeFileSync(socketPath, "");
    const withSocket = resolveClientTransport({
      env: {
        ...process.env,
        AGENTINBOX_HOME: homeDir,
      },
    });
    assert.deepEqual(withSocket, {
      kind: "socket",
      socketPath,
      source: "default",
    });
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test("unix socket control plane replaces stale socket files and serves requests", async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentinbox-socket-home-"));
  const socketPath = path.join(homeDir, "agentinbox.sock");
  const dbPath = path.join(homeDir, "agentinbox.sqlite");
  fs.writeFileSync(socketPath, "stale");

  const store = await AgentInboxStore.open(dbPath);
  let service: AgentInboxService;
  const adapters = new AdapterRegistry(store, async (input) => service.appendSourceEvent(input));
  service = new AgentInboxService(store, adapters);
  const server = createServer(service);

  try {
    await adapters.start();
    await service.start();
    const started = await startControlServer(server, {
      kind: "socket",
      socketPath,
    });
    try {
      const client = new AgentInboxClient({
        kind: "socket",
        socketPath,
        source: "flag",
      });
      const health = await client.request<{ ok: boolean }>("/healthz", undefined, "GET");
      assert.equal(health.statusCode, 200);
      assert.deepEqual(health.data, { ok: true });
    } finally {
      await started.close();
    }
    assert.equal(fs.existsSync(socketPath), false);
  } finally {
    await adapters.stop();
    await service.stop();
    store.close();
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});
