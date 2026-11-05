import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { AdapterRegistry } from "../src/adapters";
import { AgentInboxClient } from "../src/client";
import { startControlServer } from "../src/control_server";
import { checkDatabaseIntegrity } from "../src/db_integrity";
import { createServer } from "../src/http";
import { RuntimeMetrics } from "../src/runtime_metrics";
import { AgentInboxService } from "../src/service";
import { AgentInboxStore } from "../src/store";
import { TerminalDispatcher } from "../src/terminal";

function createTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function requestOverSocket(
  socketPath: string,
  requestPath: string,
): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const request = http.request({ socketPath, path: requestPath, method: "GET" }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(chunk as Buffer));
      response.on("end", () => {
        resolve({
          statusCode: response.statusCode ?? 0,
          headers: response.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        });
      });
    });
    request.on("error", reject);
    request.end();
  });
}

function createService(store: AgentInboxStore, runtimeMetrics?: RuntimeMetrics): AgentInboxService {
  let service: AgentInboxService;
  const adapters = new AdapterRegistry(store, async (input) => service.appendSourceEvent(input));
  service = new AgentInboxService(
    store,
    adapters,
    undefined,
    undefined,
    undefined,
    new TerminalDispatcher(async () => ({ stdout: "", stderr: "" })),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    runtimeMetrics,
  );
  return service;
}

test("status reports the last integrity scan instead of rescanning the database", async () => {
  const homeDir = createTempDir("agentinbox-stall-health-");
  const dbPath = path.join(homeDir, "agentinbox.sqlite");
  const store = await AgentInboxStore.open(dbPath);
  const service = createService(store);
  try {
    const opened = store.getDatabaseHealth();
    assert.equal(opened.quickCheck, "ok");
    assert.ok(opened.quickCheckAt);
    assert.ok(opened.pageCount > 0);
    const status = await service.status();
    const diagnostics = status.diagnostics as Record<string, unknown>;
    const database = diagnostics.database as Record<string, unknown>;
    // The scan reads every page of the database file, so a request handler
    // must never trigger one (#276).
    assert.equal(database.quickCheck, "ok");
    assert.equal(database.quickCheckAt, opened.quickCheckAt);
    assert.equal(database.quickCheckDurationMs, opened.quickCheckDurationMs);
  } finally {
    await service.stop();
    store.close();
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test("status exposes event loop lag and slow operation metrics", async () => {
  const homeDir = createTempDir("agentinbox-stall-metrics-");
  const dbPath = path.join(homeDir, "agentinbox.sqlite");
  const store = await AgentInboxStore.open(dbPath);
  const metrics = new RuntimeMetrics({ slowOperationThresholdMs: 0 });
  const service = createService(store, metrics);
  try {
    service.runtimeMetrics.recordEventLoopLag(1234);
    const status = await service.status();
    const diagnostics = status.diagnostics as Record<string, unknown>;
    const runtime = diagnostics.runtime as Record<string, unknown>;
    assert.equal(runtime.eventLoopLagMs, 1234);
    assert.ok((runtime.slowOperationCount as number) > 0);
    assert.ok(Array.isArray(runtime.slowOperations));
  } finally {
    await service.stop();
    store.close();
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test("control plane sheds load after a stall while healthz stays available", async () => {
  const homeDir = createTempDir("agentinbox-stall-shed-");
  const socketPath = path.join(homeDir, "agentinbox.sock");
  const dbPath = path.join(homeDir, "agentinbox.sqlite");
  const store = await AgentInboxStore.open(dbPath);
  const service = createService(store);
  const server = createServer(service);
  try {
    const started = await startControlServer(server, { kind: "socket", socketPath });
    try {
      const client = new AgentInboxClient({
        kind: "socket",
        socketPath,
        source: "flag",
      });
      const healthy = await client.request<{ ok: boolean }>("/healthz", undefined, "GET");
      assert.equal(healthy.statusCode, 200);
      assert.equal(healthy.data.ok, true);
      // A lag over the stall threshold marks a recent stall; the daemon then
      // sheds queued control plane load during the cooldown window.
      service.runtimeMetrics.recordEventLoopLag(10_000);
      const shed = await requestOverSocket(socketPath, "/status");
      assert.equal(shed.statusCode, 503);
      assert.match(shed.body, /congested/);
      assert.equal(shed.headers["retry-after"], "1");
      // Liveness must stay reachable while shedding: CLI daemon discovery
      // treats a non-200 healthz as "no daemon" and would try to start one.
      const liveness = await requestOverSocket(socketPath, "/healthz");
      assert.equal(liveness.statusCode, 200);
      assert.equal(JSON.parse(liveness.body).ok, true);
    } finally {
      await started.close();
    }
  } finally {
    await service.stop();
    store.close();
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test("local integrity check reports healthy and unreadable databases", async () => {
  const homeDir = createTempDir("agentinbox-stall-doctor-");
  const dbPath = path.join(homeDir, "agentinbox.sqlite");
  const store = await AgentInboxStore.open(dbPath);
  store.close();
  try {
    const healthy = checkDatabaseIntegrity(dbPath);
    assert.equal(healthy.ok, true);
    assert.equal(healthy.result, "ok");
    assert.equal(healthy.mode, "quick");
    assert.ok(healthy.pageCount > 0);
    assert.ok(healthy.fileBytes > 0);
    const corruptPath = path.join(homeDir, "corrupt.sqlite");
    fs.writeFileSync(corruptPath, "not a sqlite database");
    const corrupt = checkDatabaseIntegrity(corruptPath);
    assert.equal(corrupt.ok, false);
    assert.notEqual(corrupt.result, "ok");
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});
