import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { AdapterRegistry } from "../src/adapters";
import { publicEmailAttachmentCollection } from "../src/email_attachment";
import type { EmailBodyUxcClient } from "../src/email_body";
import { createServer } from "../src/http";
import type { InboxItem, SourceStream } from "../src/model";
import { AgentInboxService } from "../src/service";
import { AgentInboxStore } from "../src/store";

class FakeEmailBodyUxcClient implements EmailBodyUxcClient {
  public calls: Array<{ method: string; params?: unknown }> = [];
  public bodyReadError: Error | null = null;
  public bodyReadGate: Promise<void> | null = null;
  public bodyReadStarted: (() => void) | null = null;

  constructor(private readonly text = "fetched body") {}

  async request<T = unknown>(method: string, params?: unknown): Promise<T> {
    this.calls.push({ method, params });
    if (method === "daemon.status") {
      return {
        email_body: {
          schema_version: 1,
          parser_version: "mail-parser-test",
          input_kinds: ["inline_mime", "legacy_mime", "message_ref"],
          providers: ["imap", "gmail", "graph", "jmap"],
        },
      } as T;
    }
    if (method === "email.body.read") {
      this.bodyReadStarted?.();
      await this.bodyReadGate;
      if (this.bodyReadError) {
        throw this.bodyReadError;
      }
      return {
        schema_version: 1,
        parser_version: "mail-parser-test",
        format: "text",
        text: this.text,
        bytes: Buffer.byteLength(this.text),
        total_bytes: Buffer.byteLength(this.text),
        completeness: "complete",
        reasons: [],
        provenance: { input_kind: "message_ref" },
      } as T;
    }
    throw new Error(`unexpected UXC method: ${method}`);
  }
}

test("public email attachment collection distinguishes complete, partial, absent, and unknown metadata", () => {
  const attachment = {
    filename: "report.pdf",
    handle: { type: "email_attachment" },
  };
  const cases = [
    {
      metadata: { attachments: [attachment], attachmentCount: 1, hasAttachments: true },
      expected: { hasAttachments: true, attachmentCount: 1, attachmentsComplete: true },
    },
    {
      metadata: { attachments: [attachment], attachmentCount: 2, hasAttachments: true },
      expected: { hasAttachments: true, attachmentCount: 2, attachmentsComplete: false },
    },
    {
      metadata: { attachments: [], attachmentCount: null, hasAttachments: false },
      expected: { hasAttachments: false, attachmentCount: null, attachmentsComplete: true },
    },
    {
      metadata: { attachments: [], attachmentCount: null, hasAttachments: null },
      expected: { hasAttachments: false, attachmentCount: null, attachmentsComplete: false },
    },
    {
      metadata: { attachments: [], attachmentCount: 2, hasAttachments: null },
      expected: { hasAttachments: true, attachmentCount: 2, attachmentsComplete: false },
    },
  ];

  for (const { metadata, expected } of cases) {
    const collection = publicEmailAttachmentCollection("itm_attachment_state", metadata);
    assert.deepEqual({
      hasAttachments: collection.hasAttachments,
      attachmentCount: collection.attachmentCount,
      attachmentsComplete: collection.attachmentsComplete,
    }, expected);
  }
});

async function fixture(input: {
  rawPayload: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  uxc?: FakeEmailBodyUxcClient;
}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentinbox-email-body-"));
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
    config: {},
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
  const item: InboxItem = {
    itemId: "itm_email",
    sourceId: source.sourceId,
    sourceNativeId: "email:stable-key",
    eventVariant: "email.message.received",
    inboxId: "inb_alpha",
    occurredAt: now,
    metadata: {
      subject: "Test message",
      from: "sender@example.com",
      attachments: [{
        id: "provider-attachment-id",
        filename: "report.pdf",
        content_type: "application/pdf",
        size: 2048,
        disposition: "attachment",
        content_id: "report-content-id",
        handle: {
          type: "email_attachment",
          provider: "imap",
          account: "user@example.com",
          mailbox: "INBOX",
          locator: "not-public",
        },
        endpoint: "https://provider.example.test/download",
        auth_profile: "private-profile",
      }],
      ...input.metadata,
    },
    rawPayload: input.rawPayload,
  };
  store.insertInboxItem(item);
  const entry = store.createInboxItemEntry("inb_alpha", item, {
    summary: "Test message",
    subscriptionIds: ["sub_email"],
  });
  const adapters = new AdapterRegistry(store, async () => ({ appended: 0, deduped: 0 }), {
    homeDir: dir,
  });
  const uxc = input.uxc ?? new FakeEmailBodyUxcClient();
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
  return {
    dir,
    store,
    service,
    uxc,
    entry,
    close: async () => {
      await service.stop();
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("email body read uses embedded normalized body without calling UXC", async () => {
  const fx = await fixture({
    rawPayload: {
      type: "email_event",
      version: "v1",
      message_ref: "uxc-email-v1.secret",
      body: {
        schema_version: 1,
        parser_version: "mail-parser-test",
        format: "text",
        text: "hello 世界",
        bytes: Buffer.byteLength("hello 世界"),
        total_bytes: Buffer.byteLength("hello 世界"),
        completeness: "complete",
        reasons: [],
        provenance: { input_kind: "inline_mime" },
      },
    },
  });
  try {
    const first = await fx.service.readInboxEmailBody("agent_alpha", fx.entry.entryId, { maxBytes: 7 });
    assert.equal(first.status, "available");
    if (first.status !== "available") return;
    assert.equal(first.body.text, "hello ");
    assert.equal(first.body.returnedBytes, 6);
    assert.equal(first.body.hasMore, true);
    assert.equal(first.body.origin, "local");
    assert.ok(first.body.nextCursor);
    assert.equal(fx.uxc.calls.length, 0);

    const second = await fx.service.readInboxEmailBody("agent_alpha", fx.entry.entryId, {
      maxBytes: 6,
      cursor: first.body.nextCursor,
    });
    assert.equal(second.status, "available");
    if (second.status !== "available") return;
    assert.equal(second.body.text, "世界");
    assert.equal(second.body.hasMore, false);
    assert.equal(second.body.origin, "cache");
  } finally {
    await fx.close();
  }
});

test("email body read fetches once, caches the snapshot, and hides internal references over HTTP", async () => {
  const uxc = new FakeEmailBodyUxcClient("abcdefghij");
  const fx = await fixture({
    uxc,
    rawPayload: {
      type: "email_event",
      version: "v1",
      message_ref: "uxc-email-v1.very-long-secret-reference",
      body: null,
      raw: { mime_inline_base64: null, complete: false, representation_version: 1 },
    },
  });
  const server = createServer(fx.service);
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const firstResponse = await fetch(
      `${baseUrl}/agents/agent_alpha/inbox/entries/${encodeURIComponent(fx.entry.entryId)}/body?max_bytes=4`,
    );
    assert.equal(firstResponse.status, 200);
    const first = await firstResponse.json() as {
      status: string;
      hasAttachments: boolean;
      attachmentCount: number | null;
      attachmentsComplete: boolean;
      attachments: Array<{
        attachmentRef: string;
        filename: string | null;
        contentType: string | null;
        size: number | null;
        disposition: "attachment" | "inline" | null;
        contentId: string | null;
        status: string;
        retrievable: boolean;
      }>;
      body: { text: string; nextCursor?: string; origin: string };
    };
    assert.equal(first.status, "available");
    assert.equal(first.body.text, "abcd");
    assert.equal(first.body.origin, "fetched");
    assert.ok(first.body.nextCursor);
    assert.equal(first.hasAttachments, true);
    assert.equal(first.attachmentCount, null);
    assert.equal(first.attachmentsComplete, false);
    assert.match(first.attachments[0]!.attachmentRef, /^att_v1\.itm_email\.[A-Za-z0-9_-]{22}$/);
    assert.deepEqual(first.attachments[0], {
      attachmentRef: first.attachments[0]!.attachmentRef,
      filename: "report.pdf",
      contentType: "application/pdf",
      detectedContentType: null,
      size: 2048,
      disposition: "attachment",
      contentId: "report-content-id",
      status: "remote_only",
      retrievable: true,
    });
    assert.equal(JSON.stringify(first).includes("not-public"), false);
    assert.equal(JSON.stringify(first).includes("provider-attachment-id"), false);
    assert.equal(JSON.stringify(first).includes("private-profile"), false);
    assert.equal(JSON.stringify(first).includes("provider.example.test"), false);
    assert.equal(JSON.stringify(first).includes("message_ref"), false);
    assert.deepEqual(uxc.calls.map((call) => call.method), ["daemon.status", "email.body.read"]);
    assert.deepEqual(uxc.calls[1].params, {
      input: {
        kind: "message_ref",
        message_ref: "uxc-email-v1.very-long-secret-reference",
      },
    });

    const secondResponse = await fetch(
      `${baseUrl}/agents/agent_alpha/inbox/entries/${encodeURIComponent(fx.entry.entryId)}/body?max_bytes=6&cursor=${encodeURIComponent(first.body.nextCursor!)}`,
    );
    const second = await secondResponse.json() as {
      status: string;
      body: { text: string; hasMore: boolean; origin: string };
    };
    assert.equal(second.body.text, "efghij");
    assert.equal(second.body.hasMore, false);
    assert.equal(second.body.origin, "cache");
    assert.equal(uxc.calls.length, 2);

    const listResponse = await fetch(`${baseUrl}/agents/agent_alpha/inbox/entries`);
    const list = await listResponse.json() as {
      entries: Array<{
        metadata: { attachments: Array<Record<string, unknown>> };
        item: { metadata: { attachments: Array<Record<string, unknown>> } };
      }>;
    };
    const listText = JSON.stringify(list);
    assert.equal(listText.includes("message_ref"), false);
    assert.equal(listText.includes("very-long-secret-reference"), false);
    assert.equal(listText.includes("provider-attachment-id"), false);
    assert.equal(listText.includes("not-public"), false);
    assert.deepEqual(list.entries[0]!.metadata.attachments[0], first.attachments[0]);
    assert.deepEqual(list.entries[0]!.item.metadata.attachments[0], first.attachments[0]);

    const attachmentResponse = await fetch(
      `${baseUrl}/agents/agent_alpha/inbox/attachments/${encodeURIComponent(first.attachments[0]!.attachmentRef)}`,
    );
    assert.equal(attachmentResponse.status, 200);
    assert.deepEqual(await attachmentResponse.json(), first.attachments[0]);

    const crossInboxResponse = await fetch(
      `${baseUrl}/agents/agent_beta/inbox/attachments/${encodeURIComponent(first.attachments[0]!.attachmentRef)}`,
    );
    assert.equal(crossInboxResponse.status, 404);
    assert.deepEqual(await crossInboxResponse.json(), {
      error: `unknown inbox attachment: ${first.attachments[0]!.attachmentRef}`,
    });

    const forgedRef = `${first.attachments[0]!.attachmentRef.slice(0, -1)}x`;
    const forgedResponse = await fetch(
      `${baseUrl}/agents/agent_alpha/inbox/attachments/${encodeURIComponent(forgedRef)}`,
    );
    assert.equal(forgedResponse.status, 404);
    assert.deepEqual(await forgedResponse.json(), {
      error: `unknown inbox attachment: ${forgedRef}`,
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fx.close();
  }
});

test("email body no-fetch does not call UXC and cross-inbox reads are indistinguishable from missing entries", async () => {
  const fx = await fixture({
    rawPayload: {
      type: "email_event",
      version: "v1",
      message_ref: "uxc-email-v1.secret",
      body: null,
      raw: { mime_inline_base64: null, complete: false },
    },
  });
  try {
    const noFetch = await fx.service.readInboxEmailBody("agent_alpha", fx.entry.entryId, { fetch: false });
    assert.deepEqual(noFetch, {
      status: "unavailable",
      entryId: fx.entry.entryId,
      code: "local_body_unavailable",
      retryable: false,
      message: "No local email body is available; retry without --no-fetch.",
    });
    assert.equal(fx.uxc.calls.length, 0);

    await assert.rejects(
      fx.service.readInboxEmailBody("agent_beta", fx.entry.entryId),
      new RegExp(`unknown inbox entry: ${fx.entry.entryId}`),
    );
  } finally {
    await fx.close();
  }
});

test("partial local fallback is cached so its continuation cursor remains usable after fetch failure", async () => {
  const uxc = new FakeEmailBodyUxcClient();
  uxc.bodyReadError = new Error("provider unavailable");
  const fx = await fixture({
    uxc,
    rawPayload: {
      type: "email_event",
      version: "v1",
      message_ref: "uxc-email-v1.secret",
      body: {
        schema_version: 1,
        parser_version: "mail-parser-test",
        format: "text",
        text: "partial body",
        bytes: Buffer.byteLength("partial body"),
        completeness: "partial",
        reasons: ["inline_limit"],
        provenance: { input_kind: "inline_mime" },
      },
    },
  });
  try {
    const first = await fx.service.readInboxEmailBody("agent_alpha", fx.entry.entryId, { maxBytes: 7 });
    assert.equal(first.status, "available");
    if (first.status !== "available") return;
    assert.equal(first.body.text, "partial");
    assert.deepEqual(first.body.reasons, ["inline_limit", "fetch_provider_unavailable"]);
    assert.ok(first.body.nextCursor);

    const second = await fx.service.readInboxEmailBody("agent_alpha", fx.entry.entryId, {
      maxBytes: 8,
      cursor: first.body.nextCursor,
    });
    assert.equal(second.status, "available");
    if (second.status !== "available") return;
    assert.equal(second.body.text, " body");
    assert.equal(second.body.origin, "cache");
    assert.deepEqual(second.body.reasons, ["inline_limit", "fetch_provider_unavailable"]);
  } finally {
    await fx.close();
  }
});

test("email body read merges concurrent cache misses into one provider fetch", async () => {
  let releaseBodyRead!: () => void;
  const uxc = new FakeEmailBodyUxcClient("complete body");
  uxc.bodyReadGate = new Promise<void>((resolve) => {
    releaseBodyRead = resolve;
  });
  const bodyReadStarted = new Promise<void>((resolve) => {
    uxc.bodyReadStarted = resolve;
  });
  const fx = await fixture({
    uxc,
    rawPayload: {
      type: "email_event",
      version: "v1",
      message_ref: "uxc-email-v1.secret",
      body: null,
    },
  });
  try {
    const firstRead = fx.service.readInboxEmailBody("agent_alpha", fx.entry.entryId);
    await bodyReadStarted;
    const secondRead = fx.service.readInboxEmailBody("agent_alpha", fx.entry.entryId);
    releaseBodyRead();
    const [first, second] = await Promise.all([firstRead, secondRead]);
    assert.equal(first.status, "available");
    assert.equal(second.status, "available");
    assert.deepEqual(uxc.calls.map((call) => call.method), ["daemon.status", "email.body.read"]);
  } finally {
    await fx.close();
  }
});

test("partial cached bodies retry provider fetches and upgrade to a complete snapshot", async () => {
  const uxc = new FakeEmailBodyUxcClient("complete body");
  uxc.bodyReadError = new Error("offline");
  const fx = await fixture({
    uxc,
    rawPayload: {
      type: "email_event",
      version: "v1",
      message_ref: "uxc-email-v1.secret",
      body: {
        schema_version: 1,
        parser_version: "mail-parser-test",
        format: "text",
        text: "partial",
        bytes: Buffer.byteLength("partial"),
        completeness: "partial",
        reasons: ["inline_limit"],
      },
    },
  });
  try {
    const partial = await fx.service.readInboxEmailBody("agent_alpha", fx.entry.entryId);
    assert.equal(partial.status, "available");
    if (partial.status !== "available") return;
    assert.equal(partial.body.completeness, "partial");
    assert.deepEqual(partial.body.reasons, ["inline_limit", "fetch_provider_unavailable"]);

    uxc.bodyReadError = null;
    const complete = await fx.service.readInboxEmailBody("agent_alpha", fx.entry.entryId);
    assert.equal(complete.status, "available");
    if (complete.status !== "available") return;
    assert.equal(complete.body.text, "complete body");
    assert.equal(complete.body.completeness, "complete");
    assert.equal(complete.body.origin, "fetched");
    assert.deepEqual(uxc.calls.map((call) => call.method), [
      "daemon.status",
      "email.body.read",
      "daemon.status",
      "email.body.read",
    ]);
  } finally {
    await fx.close();
  }
});

test("email body cursors are snapshot-scoped and byte budgets never split UTF-8 characters", async () => {
  const fx = await fixture({
    rawPayload: {
      type: "email_event",
      version: "v1",
      body: {
        schema_version: 1,
        parser_version: "mail-parser-test",
        format: "text",
        text: "A😀B",
        bytes: Buffer.byteLength("A😀B"),
        completeness: "complete",
        reasons: [],
      },
    },
  });
  try {
    const first = await fx.service.readInboxEmailBody("agent_alpha", fx.entry.entryId, { maxBytes: 1 });
    assert.equal(first.status, "available");
    if (first.status !== "available") return;
    assert.equal(first.body.text, "A");
    assert.ok(first.body.nextCursor);

    await assert.rejects(
      fx.service.readInboxEmailBody("agent_alpha", fx.entry.entryId, {
        maxBytes: 1,
        cursor: first.body.nextCursor,
      }),
      /at least 4 bytes are required/,
    );
    const second = await fx.service.readInboxEmailBody("agent_alpha", fx.entry.entryId, {
      maxBytes: 4,
      cursor: first.body.nextCursor,
    });
    assert.equal(second.status, "available");
    if (second.status !== "available") return;
    assert.equal(second.body.text, "😀");
    assert.ok(second.body.nextCursor);
    const [cursorPayload, cursorSignature] = first.body.nextCursor!.split(".");
    const decodedCursor = JSON.parse(Buffer.from(cursorPayload, "base64url").toString("utf8")) as {
      offset: number;
    };
    decodedCursor.offset = 0;
    const forgedCursor = `${Buffer.from(JSON.stringify(decodedCursor), "utf8").toString("base64url")}.${cursorSignature}`;
    await assert.rejects(
      fx.service.readInboxEmailBody("agent_alpha", fx.entry.entryId, {
        cursor: forgedCursor,
      }),
      /cursor is invalid or expired/,
    );

    const now = new Date().toISOString();
    const otherItem: InboxItem = {
      itemId: "itm_email_other",
      sourceId: "src_email",
      sourceNativeId: "email:other",
      eventVariant: "email.message.received",
      inboxId: "inb_alpha",
      occurredAt: now,
      metadata: {},
      rawPayload: {
        type: "email_event",
        version: "v1",
        body: {
          schema_version: 1,
          parser_version: "mail-parser-test",
          format: "text",
          text: "other",
          bytes: Buffer.byteLength("other"),
          completeness: "complete",
          reasons: [],
        },
      },
    };
    fx.store.insertInboxItem(otherItem);
    const otherEntry = fx.store.createInboxItemEntry("inb_alpha", otherItem, {
      summary: "Other message",
      subscriptionIds: ["sub_email"],
    });
    await assert.rejects(
      fx.service.readInboxEmailBody("agent_alpha", otherEntry.entryId, {
        cursor: second.body.nextCursor,
      }),
      /cursor is invalid or expired/,
    );
  } finally {
    await fx.close();
  }
});

test("email body fetch completion does not refill cache after the entry is deleted", async () => {
  let releaseBodyRead!: () => void;
  const uxc = new FakeEmailBodyUxcClient("late body");
  uxc.bodyReadGate = new Promise<void>((resolve) => {
    releaseBodyRead = resolve;
  });
  const bodyReadStarted = new Promise<void>((resolve) => {
    uxc.bodyReadStarted = resolve;
  });
  const fx = await fixture({
    uxc,
    rawPayload: {
      type: "email_event",
      version: "v1",
      message_ref: "uxc-email-v1.secret",
      body: null,
    },
  });
  try {
    const pending = fx.service.readInboxEmailBody("agent_alpha", fx.entry.entryId);
    await bodyReadStarted;
    fx.store.ackInboxEntries("inb_alpha", [fx.entry.entryId], "2000-01-01T00:00:00.000Z");
    assert.equal(fx.store.deleteAckedInboxItems("inb_alpha", "2000-01-02T00:00:00.000Z"), 1);
    releaseBodyRead();
    const result = await pending;
    assert.deepEqual(result, {
      status: "unavailable",
      entryId: fx.entry.entryId,
      code: "not_found",
      retryable: false,
      message: "The inbox entry is no longer available.",
    });
    assert.equal(fx.store.getEmailBodyCache("inb_alpha", fx.entry.entryId), null);
  } finally {
    await fx.close();
  }
});
