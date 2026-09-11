import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import test from "node:test";
import { AdapterRegistry } from "../src/adapters";
import { AgentInboxClient } from "../src/client";
import {
  type EmailAttachmentUxcClient,
} from "../src/email_attachment_content";
import { publicEmailAttachmentCollection } from "../src/email_attachment";
import { createServer } from "../src/http";
import type { InboxItem, SourceStream } from "../src/model";
import { AgentInboxService } from "../src/service";
import { AgentInboxStore } from "../src/store";

const execFileAsync = promisify(execFile);

class FakeAttachmentUxcClient implements EmailAttachmentUxcClient {
  readonly calls: Array<{ method: string; params?: unknown }> = [];
  gate: Promise<void> | null = null;
  started: (() => void) | null = null;

  constructor(readonly content: Buffer) {}

  async request<T = unknown>(method: string, params?: unknown): Promise<T> {
    this.calls.push({ method, params });
    if (method !== "email.attachment.get") {
      throw new Error(`unexpected UXC method: ${method}`);
    }
    this.started?.();
    await this.gate;
    const input = params as {
      handle: string;
      output: string;
      max_bytes: number;
    };
    assert.equal(path.isAbsolute(input.output), true);
    assert.equal(JSON.parse(input.handle).type, "email_attachment");
    fs.writeFileSync(input.output, this.content);
    return {
      size_bytes: this.content.length,
      sha256: crypto.createHash("sha256").update(this.content).digest("hex"),
      content_type: "application/pdf",
    } as T;
  }
}

async function fixture(options?: {
  mode?: "metadata" | "store_reference";
  content?: Buffer;
  declaredSize?: number;
  maxBytesPerAttachment?: number;
  maxBytesPerMessage?: number;
  filename?: string;
  secondAttachment?: boolean;
}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentinbox-email-attachment-"));
  const store = await AgentInboxStore.open(path.join(dir, "agentinbox.sqlite"));
  const now = new Date().toISOString();
  store.insertSourceHost({
    hostId: "hst_email",
    hostType: "email",
    hostKey: "email-primary",
    config: {},
    status: "active",
    createdAt: now,
    updatedAt: now,
  });
  const source: SourceStream = {
    sourceId: "src_email",
    hostId: "hst_email",
    streamKind: "email_mailbox",
    streamKey: "primary",
    sourceType: "email_mailbox",
    sourceKey: "email-primary",
    config: {
      attachmentPolicy: {
        mode: options?.mode ?? "store_reference",
        maxAttachmentsPerMessage: 4,
        maxBytesPerAttachment: options?.maxBytesPerAttachment ?? 1024,
        maxBytesPerMessage: options?.maxBytesPerMessage ?? 4096,
        allowContentTypes: ["application/pdf"],
        retentionSecs: 3600,
      },
    },
    status: "active",
    checkpoint: null,
    createdAt: now,
    updatedAt: now,
  };
  store.insertSource(source);
  for (const [agentId, inboxId] of [["agent_alpha", "inb_alpha"], ["agent_beta", "inb_beta"]]) {
    store.insertAgent({
      agentId,
      status: "active",
      runtimeKind: "unknown",
      createdAt: now,
      updatedAt: now,
      lastSeenAt: now,
    });
    store.insertInbox({
      inboxId,
      ownerAgentId: agentId,
      createdAt: now,
    });
  }
  const attachments = [{
    filename: options?.filename ?? "report.pdf",
    content_type: "application/pdf",
    size: options?.declaredSize ?? options?.content?.length ?? 16,
    disposition: "attachment",
    handle: {
      type: "email_attachment",
      provider: "imap",
      account: "private@example.test",
      locator: "private-provider-locator-1",
    },
  }, ...(options?.secondAttachment ? [{
    filename: "report-2.pdf",
    content_type: "application/pdf",
    size: options?.declaredSize ?? options?.content?.length ?? 16,
    disposition: "attachment",
    handle: {
      type: "email_attachment",
      provider: "imap",
      account: "private@example.test",
      locator: "private-provider-locator-2",
    },
  }] : [])];
  const item: InboxItem = {
    itemId: "itm_email_attachment",
    sourceId: source.sourceId,
    sourceNativeId: "email:attachment-test",
    eventVariant: "email.message.received",
    inboxId: "inb_alpha",
    occurredAt: now,
    metadata: {
      attachments,
      attachmentCount: attachments.length,
      hasAttachments: true,
      attachmentsComplete: true,
    },
    rawPayload: {},
  };
  store.insertInboxItem(item);
  const uxc = new FakeAttachmentUxcClient(
    options?.content ?? Buffer.from("%PDF-1.7\nfixture\n", "utf8"),
  );
  const adapters = new AdapterRegistry(store, async () => ({ appended: 0, deduped: 0 }), {
    homeDir: dir,
  });
  const service = new AgentInboxService(
    store,
    adapters,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    uxc,
  );
  const attachmentRefs = publicEmailAttachmentCollection(
    item.itemId,
    item.metadata,
  ).attachments.map((attachment) => attachment.attachmentRef);
  return {
    dir,
    store,
    service,
    uxc,
    item,
    attachmentRef: attachmentRefs[0]!,
    attachmentRefs,
    close: async () => {
      await service.stop();
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("email attachment materialization is single-flight and serves managed bytes", async () => {
  const fx = await fixture({ filename: "report\r\nx-injected: true.pdf" });
  const server = createServer(fx.service);
  try {
    const [first, second] = await Promise.all([
      fx.service.materializeInboxEmailAttachment("agent_alpha", fx.attachmentRef),
      fx.service.materializeInboxEmailAttachment("agent_alpha", fx.attachmentRef),
    ]);
    assert.equal(first.status, "available");
    assert.deepEqual(second, first);
    assert.equal(fx.uxc.calls.length, 1);
    assert.equal(JSON.stringify(first).includes("private-provider-locator"), false);
    assert.equal(JSON.stringify(first).includes("private@example.test"), false);

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const response = await fetch(
      `${baseUrl}/agents/agent_alpha/inbox/attachments/${encodeURIComponent(fx.attachmentRef)}/content`,
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "application/pdf");
    assert.equal(response.headers.get("content-length"), String(fx.uxc.content.length));
    assert.equal(response.headers.get("x-injected"), null);
    assert.equal(response.headers.get("content-disposition")?.includes("\r"), false);
    assert.equal(response.headers.get("content-disposition")?.includes("\n"), false);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), fx.uxc.content);

    const client = new AgentInboxClient({ kind: "url", baseUrl, source: "flag" });
    const clientResponse = await client.requestBytes(
      `/agents/agent_alpha/inbox/attachments/${encodeURIComponent(fx.attachmentRef)}/content`,
    );
    assert.equal(clientResponse.statusCode, 200);
    assert.deepEqual(clientResponse.data, fx.uxc.content);

    const outputPath = path.join(fx.dir, "downloaded-report.pdf");
    const cliArgs = [
      "--require",
      "ts-node/register",
      "src/cli.ts",
      "inbox",
      "attachment",
      "get",
      fx.attachmentRef,
      "--agent-id",
      "agent_alpha",
      "--output",
      outputPath,
    ];
    const cliResult = await execFileAsync(process.execPath, cliArgs, {
      cwd: process.cwd(),
      env: {
        ...process.env,
        AGENTINBOX_URL: baseUrl,
      },
    });
    assert.deepEqual(fs.readFileSync(outputPath), fx.uxc.content);
    assert.equal(JSON.parse(cliResult.stdout).bytes, fx.uxc.content.length);
    await assert.rejects(
      execFileAsync(process.execPath, cliArgs, {
        cwd: process.cwd(),
        env: {
          ...process.env,
          AGENTINBOX_URL: baseUrl,
        },
      }),
      /EEXIST/,
    );
    assert.deepEqual(fs.readFileSync(outputPath), fx.uxc.content);

    const crossOwner = await fetch(
      `${baseUrl}/agents/agent_beta/inbox/attachments/${encodeURIComponent(fx.attachmentRef)}/content`,
    );
    assert.equal(crossOwner.status, 404);
    assert.equal(fx.uxc.calls.length, 1);

    const selector = fx.attachmentRef.split(".").at(-1)!;
    const materialization = fx.store.getEmailAttachmentMaterialization(fx.item.itemId, selector);
    assert.ok(materialization?.objectKey);
    fs.rmSync(path.join(fx.dir, "attachments", materialization.objectKey));
    const missingObject = await fetch(
      `${baseUrl}/agents/agent_alpha/inbox/attachments/${encodeURIComponent(fx.attachmentRef)}/content`,
    );
    assert.equal(missingObject.status, 404);
    const missingBody = JSON.stringify(await missingObject.json());
    assert.equal(missingBody.includes(fx.dir), false);
    assert.equal(missingBody.includes(materialization.objectKey), false);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fx.close();
  }
});

test("email attachment policy and actual byte limits fail closed", async () => {
  const metadataOnly = await fixture({ mode: "metadata" });
  const oversized = await fixture({
    content: Buffer.from("%PDF-oversized", "utf8"),
    declaredSize: 4,
    maxBytesPerAttachment: 4,
  });
  const server = createServer(metadataOnly.service);
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const endpoint = `http://127.0.0.1:${address.port}/agents/agent_alpha/inbox/attachments/${encodeURIComponent(metadataOnly.attachmentRef)}`;
    const unavailable = await fetch(`${endpoint}/content`);
    assert.equal(unavailable.status, 404);
    const rejected = await fetch(`${endpoint}/materialize`, { method: "POST" });
    assert.equal(rejected.status, 400);
    assert.deepEqual(await rejected.json(), {
      error: "This email source does not allow attachment content storage.",
    });
    assert.equal(
      JSON.stringify(await unavailable.json()).includes("private-provider-locator"),
      false,
    );
    assert.equal(metadataOnly.uxc.calls.length, 0);

    await assert.rejects(
      oversized.service.materializeInboxEmailAttachment("agent_alpha", oversized.attachmentRef),
      /size did not match/,
    );
    assert.equal(oversized.uxc.calls.length, 1);
    assert.equal(
      oversized.store.getEmailAttachmentMaterialization(
        oversized.item.itemId,
        oversized.attachmentRef.split(".").at(-1)!,
      )?.status,
      "rejected",
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await metadataOnly.close();
    await oversized.close();
  }
});

test("email attachment materialization serializes per-message byte budgets", async () => {
  const content = Buffer.from("%PDF-0123456789", "utf8");
  const fx = await fixture({
    content,
    declaredSize: content.length,
    maxBytesPerMessage: content.length + 1,
    secondAttachment: true,
  });
  try {
    const results = await Promise.allSettled(
      fx.attachmentRefs.map((attachmentRef) =>
        fx.service.materializeInboxEmailAttachment("agent_alpha", attachmentRef)
      ),
    );
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected").length, 1);
    const rejected = results.find((result) => result.status === "rejected");
    assert.match(String(rejected && rejected.status === "rejected" ? rejected.reason : ""), /stored attachment byte limit/);
    assert.equal(fx.uxc.calls.length, 1);
  } finally {
    await fx.close();
  }
});

test("email attachment materialization rechecks ownership after retrieval", async () => {
  const fx = await fixture();
  let release!: () => void;
  fx.uxc.gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started!: () => void;
  const startedPromise = new Promise<void>((resolve) => {
    started = resolve;
  });
  fx.uxc.started = started;
  try {
    const materializing = fx.service.materializeInboxEmailAttachment(
      "agent_alpha",
      fx.attachmentRef,
    );
    await startedPromise;
    fx.store.deleteAgent("agent_alpha");
    release();
    await assert.rejects(materializing, /unknown inbox attachment/);
    assert.equal(
      fx.store.getEmailAttachmentMaterialization(
        fx.item.itemId,
        fx.attachmentRef.split(".").at(-1)!,
      ),
      null,
    );
    const objectFiles = fs.existsSync(path.join(fx.dir, "attachments", "objects"))
      ? fs.readdirSync(path.join(fx.dir, "attachments", "objects"), { recursive: true })
      : [];
    assert.equal(objectFiles.length, 0);
  } finally {
    await fx.close();
  }
});
