import fs from "node:fs";
import BetterSqlite3 from "better-sqlite3";
import { AgentInboxStore } from "../../src/store";
import { SqliteEventBusBackend } from "../../src/backend";

interface Command {
  operation: "apply" | "create" | "reset" | "commit" | "append";
  gate?: string;
  resolved?: string;
}

async function main() {
  const [dbPath, streamId] = process.argv.slice(2);
  const store = await AgentInboxStore.open(dbPath);
  const backend = new SqliteEventBusBackend(store);
  // Test-only SQLite instrumentation: barriers run inside the REAL writer
  // transaction, without replacing the semantic operation under test.
  const db = (store as unknown as { db: BetterSqlite3.Database }).db;
  process.once("message", async (command: Command) => {
    let gated = false;
    if (command.gate) {
      const gate = command.gate;
      db.function("compaction_test_gate", () => {
        if (gated) return 0;
        gated = true;
        fs.writeFileSync(`${gate}.held`, "");
        const deadline = Date.now() + 10_000;
        while (!fs.existsSync(`${gate}.release`)) {
          if (Date.now() > deadline) throw new Error("SQLite test barrier timed out");
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
        }
        return 0;
      });
      const trigger = command.operation === "apply"
        ? "before update of payload_pruned_at on stream_events"
        : "before insert on consumers";
      db.exec(`create temp trigger compaction_test_gate ${trigger}
        begin select compaction_test_gate(); end`);
    }
    if (command.resolved) {
      const signal = command.resolved;
      if (command.operation === "create") {
        const original = store.insertConsumer.bind(store);
        store.insertConsumer = (record) => { fs.writeFileSync(signal, ""); original(record); };
      } else if (command.operation === "reset") {
        const original = store.resetConsumer.bind(store);
        store.resetConsumer = (id, input) => { fs.writeFileSync(signal, ""); return original(id, input); };
      } else if (command.operation === "commit") {
        const original = store.updateConsumerOffset.bind(store);
        store.updateConsumerOffset = (id, next, committed) => {
          fs.writeFileSync(signal, "");
          return original(id, next, committed);
        };
      } else {
        fs.writeFileSync(signal, "");
      }
    }
    try {
      let value: unknown;
      switch (command.operation) {
        case "apply":
          value = await backend.applyStreamCompaction({ streamId, retentionMs: 86_400_000 });
          break;
        case "create":
          value = await backend.ensureConsumer({
            streamId, consumerKey: "racing", subscriptionId: "racing", startPolicy: "earliest",
          });
          break;
        case "reset":
          value = await backend.reset({ consumerId: "existing", startPolicy: "earliest" });
          break;
        case "commit":
          value = await backend.commit({ consumerId: "existing", committedOffset: 0 });
          break;
        case "append":
          value = await backend.append({
            streamId, events: [{
              sourceId: "source", sourceNativeId: "event", eventVariant: "test",
              metadata: {}, rawPayload: { replacement: true },
            }],
          });
          break;
      }
      process.send?.({ ok: true, value });
    } catch (error) {
      process.send?.({ ok: false, error: {
        message: String(error),
        ...(error as Record<string, unknown>),
      } });
    } finally {
      store.close();
      process.disconnect?.();
    }
  });
  process.send?.({ ready: true });
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
