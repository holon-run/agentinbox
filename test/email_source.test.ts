import test from "node:test";
import assert from "node:assert/strict";
import { DeliveryHandle, SourceStream } from "../src/model";
import {
  EmailUxcCallClient,
  type EmailPollSubscriptionConfig,
  buildEmailMailboxSourceSpec,
  emailDeliveryOperationsForHandle,
  invokeEmailDeliveryOperation,
  normalizeEmailMailboxEvent,
  parseEmailMailboxSourceConfig,
} from "../src/sources/email";
import { RemoteSourceModuleRegistry, builtInModuleIdForSourceType } from "../src/sources/remote_modules";

class FakeEmailUxcClient implements EmailUxcCallClient {
  public calls: Array<{ method: string; params?: unknown }> = [];

  async request<T = unknown>(method: string, params?: unknown): Promise<T> {
    this.calls.push({ method, params });
    return { message_id: "<uxc-1@localhost>", accepted_recipients: 1 } as T;
  }
}

class MethodNotFoundEmailClient implements EmailUxcCallClient {
  async request<T = unknown>(_method: string, _params?: unknown): Promise<T> {
    const error = new Error("method not found") as Error & { code: number };
    error.code = -32601;
    throw error;
  }
}

function emailSource(config: Record<string, unknown>): SourceStream {
  const now = new Date().toISOString();
  return {
    sourceId: "src_email",
    sourceType: "email_mailbox",
    sourceKey: "email-primary",
    configRef: null,
    config,
    status: "active",
    checkpoint: null,
    createdAt: now,
    updatedAt: now,
  };
}

const imapConfig = {
  provider: "imap",
  endpoint: "imaps://imap.example.com:993",
  uxcAuth: "email-primary",
  account: "user@example.com",
  smtpEndpoint: "smtp://localhost:2525",
  fromAddress: "bot@example.com",
};

function imapEmailEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "email_event",
    version: "v1",
    provider: "imap",
    account: "user@example.com",
    mailbox: "INBOX",
    event_kind: "message_received",
    message: {
      uid: "42",
      message_id: "<m1@example.com>",
      thread_id: null,
      conversation_id: null,
      from: "Alice <alice@example.org>",
      to: [{ raw: "user@example.com" }],
      cc: [],
      bcc: [],
      subject: "Quarterly report",
      date: "Mon, 07 Sep 2026 12:00:00 +0000",
      snippet: "Please review the attached report",
      attachments: [
        {
          id: "1.2",
          filename: "report.pdf",
          content_type: "application/pdf",
          size: 2048,
          disposition: "attachment",
          content_id: null,
          handle: { type: "email_attachment", provider: "imap", account: "user@example.com" },
        },
      ],
      has_attachments: true,
      attachment_count: 1,
      flags: [],
    },
    raw: { mime_inline: null, mime_truncated: true, size_bytes: 204800 },
    reply_handle: {
      type: "email_imap",
      provider: "imap",
      account: "user@example.com",
      mailbox: "INBOX",
      message_id: "<m1@example.com>",
      uid: "42",
    },
    ...overrides,
  };
}

function graphEmailEvent(): Record<string, unknown> {
  return {
    type: "email_event",
    version: "v1",
    provider: "graph",
    account: "user@example.com",
    mailbox: "INBOX",
    event_kind: "message_received",
    message: {
      uid: "AAMkAGI=",
      message_id: "<graph-1@contoso.com>",
      thread_id: "AAQkAGI=",
      from: { name: "Bob", address: "bob@contoso.com" },
      to: [{ name: "User", address: "user@example.com" }],
      cc: [],
      subject: "Graph message",
      date: "2026-09-07T12:00:00Z",
      snippet: "hello from graph",
      attachments: [],
      has_attachments: null,
      attachment_count: null,
      flags: [],
    },
    raw: { provider_payload: { id: "AAMkAGI=" } },
    reply_handle: {
      type: "email_provider",
      provider: "graph",
      account: "user@example.com",
      message_id: "<graph-1@contoso.com>",
      uid: "AAMkAGI=",
    },
  };
}

test("parseEmailMailboxSourceConfig validates provider, endpoint, and auth", () => {
  const config = parseEmailMailboxSourceConfig(emailSource(imapConfig));
  assert.equal(config.provider, "imap");
  assert.equal(config.endpoint, "imaps://imap.example.com:993");
  assert.equal(config.uxcAuth, "email-primary");
  assert.equal(config.mailbox, "INBOX");
  assert.equal(config.pollIntervalSecs, 60);
  assert.equal(config.smtpEndpoint, "smtp://localhost:2525");
  assert.equal(config.fromAddress, "bot@example.com");

  assert.throws(() => parseEmailMailboxSourceConfig(emailSource({ provider: "smtp" })), /config\.provider must be one of/);
  assert.throws(() => parseEmailMailboxSourceConfig(emailSource({ provider: "imap", uxcAuth: "x" })), /imap requires config\.endpoint/);
  assert.throws(() => parseEmailMailboxSourceConfig(emailSource({ provider: "imap", endpoint: "https://x", uxcAuth: "x" })), /imap:\/\//);
  assert.throws(() => parseEmailMailboxSourceConfig(emailSource({ provider: "imap", endpoint: "imap://x" })), /requires config\.uxcAuth/);
  assert.throws(() => parseEmailMailboxSourceConfig(emailSource({ ...imapConfig, pollIntervalSecs: 5 })), /pollIntervalSecs/);
  assert.throws(() => parseEmailMailboxSourceConfig(emailSource({ ...imapConfig, initialFetchLimit: -1 })), /initialFetchLimit/);
  assert.throws(() => parseEmailMailboxSourceConfig(emailSource({ ...imapConfig, initialFetchLimit: 101 })), /initialFetchLimit/);
  assert.throws(() => parseEmailMailboxSourceConfig(emailSource({ ...imapConfig, initialFetchLimit: 2.5 })), /initialFetchLimit/);
  assert.throws(() => parseEmailMailboxSourceConfig(emailSource({ ...imapConfig, smtpEndpoint: "smtps://x:465" })), /smtp:\/\//);
  assert.throws(() => parseEmailMailboxSourceConfig(emailSource({ provider: "jmap", uxcAuth: "x" })), /jmap requires config\.endpoint/);

  const gmailDefaults = parseEmailMailboxSourceConfig(emailSource({ provider: "gmail", uxcAuth: "gmail-oauth" }));
  assert.equal(gmailDefaults.endpoint, "https://gmail.googleapis.com/gmail/v1/users/me/messages");
  const graphDefaults = parseEmailMailboxSourceConfig(emailSource({ provider: "graph", uxcAuth: "graph-oauth" }));
  assert.ok(graphDefaults.endpoint.startsWith("https://graph.microsoft.com/"));
});

test("buildEmailMailboxSourceSpec emits imap idle stream spec", () => {
  const spec = buildEmailMailboxSourceSpec(parseEmailMailboxSourceConfig(emailSource(imapConfig)));
  assert.equal(spec.mode, "stream");
  assert.equal(spec.transport_hint, "email_imap_idle");
  assert.equal(spec.endpoint, "imaps://imap.example.com:993");
  assert.deepEqual(spec.args, { mailbox: "INBOX", account: "user@example.com", initial_fetch_limit: 25 });
  assert.deepEqual(spec.options, { auth: "email-primary", artifact_compaction: false });
  assert.equal(spec.poll_config, undefined);

  const zeroBackfill = buildEmailMailboxSourceSpec(
    parseEmailMailboxSourceConfig(emailSource({ ...imapConfig, initialFetchLimit: 0 })),
  );
  assert.equal(zeroBackfill.args?.initial_fetch_limit, 0);
});

test("buildEmailMailboxSourceSpec emits provider poll spec with uid checkpointing", () => {
  const spec = buildEmailMailboxSourceSpec(
    parseEmailMailboxSourceConfig(emailSource({ provider: "gmail", uxcAuth: "gmail-oauth", pollIntervalSecs: 120 })),
  );
  assert.equal(spec.mode, "poll");
  assert.equal(spec.transport_hint, "email_provider_poll");
  assert.deepEqual(spec.args, { provider: "gmail", mailbox: "INBOX" });
  const pollConfig = spec.poll_config as EmailPollSubscriptionConfig | undefined;
  assert.equal(pollConfig?.initial_items_limit, 25);
  assert.deepEqual(spec.poll_config, {
    interval_secs: 120,
    initial_items_limit: 25,
    extract_items_pointer: "/items",
    checkpoint_strategy: { type: "item_key", item_key_pointer: "/message/uid" },
  });
  assert.deepEqual(spec.options, { auth: "gmail-oauth", artifact_compaction: false });
});

test("normalizeEmailMailboxEvent maps imap email_event to inbox item", () => {
  const source = emailSource(imapConfig);
  const normalized = normalizeEmailMailboxEvent(source, parseEmailMailboxSourceConfig(source), imapEmailEvent());

  assert.ok(normalized?.metadata);
  assert.equal(normalized.sourceNativeId, "email:imap:user@example.com:INBOX:42");
  assert.equal(normalized.eventVariant, "email.message.received");
  assert.equal(normalized.occurredAt, "2026-09-07T12:00:00.000Z");
  assert.equal(normalized.metadata.provider, "imap");
  assert.equal(normalized.metadata.messageId, "<m1@example.com>");
  assert.equal(normalized.metadata.providerMessageId, "42");
  assert.equal(normalized.metadata.from, "alice@example.org");
  assert.equal(normalized.metadata.fromName, "Alice");
  assert.deepEqual(normalized.metadata.to, [{ address: "user@example.com" }]);
  assert.equal(normalized.metadata.subject, "Quarterly report");
  assert.equal(normalized.metadata.textPreview, "Please review the attached report");
  assert.equal(normalized.metadata.hasAttachments, true);
  assert.equal(normalized.metadata.attachmentCount, 1);
  assert.equal((normalized.metadata.attachments as Array<Record<string, unknown>>).length, 1);
  assert.deepEqual(normalized.rawPayload, imapEmailEvent());
  assert.equal(normalized.deliveryHandle?.provider, "email");
  assert.equal(normalized.deliveryHandle?.surface, "message_reply");
  assert.equal(normalized.deliveryHandle?.targetRef, "alice@example.org");
  assert.equal(normalized.deliveryHandle?.threadRef, "<m1@example.com>");
  assert.equal(normalized.deliveryHandle?.replyMode, "reply");
});

test("normalizeEmailMailboxEvent keeps provider objects and nullable attachment count", () => {
  const source = emailSource({ provider: "graph", uxcAuth: "graph-oauth", account: "user@example.com" });
  const normalized = normalizeEmailMailboxEvent(source, parseEmailMailboxSourceConfig(source), graphEmailEvent());

  assert.ok(normalized?.metadata);
  assert.equal(normalized.sourceNativeId, "email:graph:user@example.com:INBOX:AAMkAGI=");
  assert.equal(normalized.metadata.from, "bob@contoso.com");
  assert.equal(normalized.metadata.fromName, "Bob");
  assert.equal(normalized.metadata.attachmentCount, null);
  assert.equal(normalized.metadata.hasAttachments, false);
  assert.equal(normalized.deliveryHandle?.targetRef, "bob@contoso.com");
});

test("normalizeEmailMailboxEvent guards envelope type, version, and event kind", () => {
  const source = emailSource(imapConfig);
  const config = parseEmailMailboxSourceConfig(source);
  assert.equal(normalizeEmailMailboxEvent(source, config, { type: "other_event" }), null);
  assert.equal(normalizeEmailMailboxEvent(source, config, imapEmailEvent({ version: "v2" })), null);
  assert.equal(normalizeEmailMailboxEvent(source, config, imapEmailEvent({ event_kind: "message_updated" })), null);
  assert.equal(normalizeEmailMailboxEvent(source, config, imapEmailEvent({ message: {} })), null);
});

test("normalizeEmailMailboxEvent applies address allowlist", () => {
  const source = emailSource({ ...imapConfig, addressAllowlist: ["boss@example.com"] });
  const config = parseEmailMailboxSourceConfig(source);
  assert.equal(normalizeEmailMailboxEvent(source, config, imapEmailEvent()), null);

  const allowedSource = emailSource({ ...imapConfig, addressAllowlist: ["alice@example.org"] });
  const allowed = normalizeEmailMailboxEvent(allowedSource, parseEmailMailboxSourceConfig(allowedSource), imapEmailEvent());
  assert.ok(allowed);
});

test("email module registers as builtin.email_mailbox and maps events end to end", async () => {
  assert.equal(builtInModuleIdForSourceType("email_mailbox"), "builtin.email_mailbox");
  const registry = new RemoteSourceModuleRegistry();
  const module = await registry.resolve(emailSource(imapConfig), "/tmp/agentinbox-test-home");
  assert.equal(module.id, "builtin.email_mailbox");

  module.validateConfig(emailSource(imapConfig));
  const spec = module.buildManagedSourceSpec!(emailSource(imapConfig));
  assert.equal(spec.transport_hint, "email_imap_idle");

  const mapped = await module.mapRawEvent!(imapEmailEvent(), emailSource(imapConfig));
  assert.ok(mapped?.eventVariant);
  assert.equal(mapped.eventVariant, "email.message.received");
  assert.equal(mapped.sourceNativeId, "email:imap:user@example.com:INBOX:42");

  const capabilities = module.describeCapabilities!(emailSource(imapConfig));
  assert.equal(capabilities.sourceKind, "email_mailbox");
});

const replyHandle: DeliveryHandle = {
  provider: "email",
  surface: "message_reply",
  targetRef: "alice@example.org",
  threadRef: "<m1@example.com>",
  replyMode: "reply",
};

test("emailDeliveryOperationsForHandle exposes send_text and reply_text", () => {
  const operations = emailDeliveryOperationsForHandle(replyHandle);
  assert.equal(operations.length, 2);
  assert.equal(operations[0].name, "send_text");
  assert.equal(operations[0].canonicalTextAlias, true);
  assert.equal(operations[1].name, "reply_text");
  assert.deepEqual(emailDeliveryOperationsForHandle({ ...replyHandle, provider: "telegram" }), []);
  assert.deepEqual(emailDeliveryOperationsForHandle({ ...replyHandle, surface: "issue_comment" }), []);
});

test("invokeEmailDeliveryOperation sends threaded reply through uxc email.reply", async () => {
  const client = new FakeEmailUxcClient();
  const result = await invokeEmailDeliveryOperation(replyHandle, "reply_text", {
    text: "Thanks, reviewed.",
    subject: "Quarterly report",
    correlationKey: "reply-42",
  }, { source: emailSource(imapConfig), client });

  assert.equal(result.status, "sent");
  assert.equal(client.calls.length, 1);
  assert.equal(client.calls[0].method, "email.reply");
  assert.deepEqual(client.calls[0].params, {
    smtp_url: "smtp://localhost:2525",
    from: "bot@example.com",
    to: ["alice@example.org"],
    subject: "Re: Quarterly report",
    text: "Thanks, reviewed.",
    in_reply_to: "<m1@example.com>",
    auth: "email-primary",
    message_id: "<agentinbox-reply-42@localhost>",
    reply_handle: { message_id: "<m1@example.com>", account: "user@example.com", mailbox: "INBOX" },
  });
});

test("invokeEmailDeliveryOperation keeps explicit Re subject and to override", async () => {
  const client = new FakeEmailUxcClient();
  await invokeEmailDeliveryOperation(replyHandle, "reply_text", {
    text: "done",
    subject: "Re: Quarterly report",
    to: ["carol@example.net"],
    cc: ["dave@example.net"],
  }, { source: emailSource(imapConfig), client });

  const params = client.calls[0].params as Record<string, unknown>;
  assert.equal(params.subject, "Re: Quarterly report");
  assert.deepEqual(params.to, ["carol@example.net"]);
  assert.deepEqual(params.cc, ["dave@example.net"]);
});

test("invokeEmailDeliveryOperation sends new email through uxc email.send", async () => {
  const client = new FakeEmailUxcClient();
  const sendHandle: DeliveryHandle = { provider: "email", surface: "message_send", targetRef: "alice@example.org" };
  await invokeEmailDeliveryOperation(sendHandle, "send_text", {
    text: "Hello",
    subject: "Ping",
    smtpEndpoint: "smtp://relay.local:25",
    from: "bot@example.com",
  }, { client });

  assert.equal(client.calls[0].method, "email.send");
  const params = client.calls[0].params as Record<string, unknown>;
  assert.equal(params.smtp_url, "smtp://relay.local:25");
  assert.equal(params.in_reply_to, undefined);
  assert.equal(params.reply_handle, undefined);
});

test("invokeEmailDeliveryOperation validates required fields", async () => {
  const client = new FakeEmailUxcClient();
  await assert.rejects(
    () => invokeEmailDeliveryOperation(replyHandle, "reply_text", { text: "hi" }, { client }),
    /requires input\.smtpEndpoint or source config smtpEndpoint/,
  );
  await assert.rejects(
    () => invokeEmailDeliveryOperation(replyHandle, "reply_text", { text: "hi", smtpEndpoint: "smtp://x" }, { client }),
    /requires input\.from/,
  );
  const sendHandle: DeliveryHandle = { provider: "email", surface: "message_send", targetRef: "alice@example.org" };
  await assert.rejects(
    () => invokeEmailDeliveryOperation(sendHandle, "send_text", { text: "hi", smtpEndpoint: "smtp://x", from: "a@b.c" }, { client }),
    /requires input\.subject/,
  );
  const canonicalReply = await invokeEmailDeliveryOperation(replyHandle, "send_text", {
    text: "hi",
    smtpEndpoint: "smtp://x",
    from: "a@b.c",
  }, { client });
  assert.equal(canonicalReply.status, "sent");
  assert.equal((client.calls.at(-1)?.params as Record<string, unknown>).subject, "Re: your message");
});

test("invokeEmailDeliveryOperation wraps missing daemon RPC as upgrade hint", async () => {
  await assert.rejects(
    () => invokeEmailDeliveryOperation(replyHandle, "reply_text", {
      text: "hi",
      smtpEndpoint: "smtp://x",
      from: "a@b.c",
    }, { client: new MethodNotFoundEmailClient() }),
    /does not support email\.reply.*upgrade uxc/s,
  );
});
