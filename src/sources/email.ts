import { UxcDaemonClient } from "@holon-run/uxc-daemon-client";
import {
  AppendSourceEventInput,
  DeliveryAttempt,
  DeliveryHandle,
  DeliveryOperationDescriptor,
  DeliveryRequest,
  SourceStream,
} from "../model";
import type { ManagedSourceSpec } from "./remote_modules";

export const EMAIL_DEFAULT_MAILBOX = "INBOX";
export const EMAIL_MAILBOX_DEFAULT_POLL_INTERVAL_SECS = 60;
export const EMAIL_EVENT_TYPE = "email_event";
export const EMAIL_EVENT_VERSION = "v1";
export const GMAIL_MESSAGES_ENDPOINT = "https://gmail.googleapis.com/gmail/v1/users/me/messages";
export const GRAPH_MESSAGES_ENDPOINT = "https://graph.microsoft.com/v1.0/me/messages?$expand=attachments";

export type EmailMailboxProvider = "imap" | "gmail" | "graph" | "jmap";

const EMAIL_MAILBOX_PROVIDERS = new Set<string>(["imap", "gmail", "graph", "jmap"]);
const EMAIL_DEFAULT_ENDPOINTS: Partial<Record<EmailMailboxProvider, string>> = {
  gmail: GMAIL_MESSAGES_ENDPOINT,
  graph: GRAPH_MESSAGES_ENDPOINT,
};

export interface EmailMailboxSourceConfig {
  provider: EmailMailboxProvider;
  endpoint: string;
  uxcAuth: string;
  account?: string;
  mailbox: string;
  pollIntervalSecs: number;
  smtpEndpoint?: string;
  fromAddress?: string;
  addressAllowlist?: string[];
}

export function parseEmailMailboxSourceConfig(source: SourceStream): EmailMailboxSourceConfig {
  const config = source.config ?? {};
  const providerRaw = asString(config.provider) ?? asString(config.emailProvider);
  if (!providerRaw) {
    throw new Error("email_mailbox requires config.provider (imap, gmail, graph, or jmap)");
  }
  const provider = providerRaw.trim().toLowerCase();
  if (!EMAIL_MAILBOX_PROVIDERS.has(provider)) {
    throw new Error(`email_mailbox config.provider must be one of imap, gmail, graph, jmap; got ${providerRaw}`);
  }

  const endpointRaw = asString(config.endpoint);
  let endpoint: string;
  if (provider === "imap") {
    if (!endpointRaw) {
      throw new Error("email_mailbox with provider=imap requires config.endpoint (imap:// or imaps://)");
    }
    if (!/^imaps?:\/\//i.test(endpointRaw)) {
      throw new Error(`email_mailbox imap endpoint must start with imap:// or imaps://; got ${endpointRaw}`);
    }
    endpoint = endpointRaw;
  } else {
    const fallback = EMAIL_DEFAULT_ENDPOINTS[provider as Exclude<EmailMailboxProvider, "imap">];
    if (endpointRaw) {
      if (!/^https?:\/\//i.test(endpointRaw)) {
        throw new Error(`email_mailbox ${provider} endpoint must start with http:// or https://; got ${endpointRaw}`);
      }
      endpoint = endpointRaw;
    } else if (fallback) {
      endpoint = fallback;
    } else {
      throw new Error(`email_mailbox with provider=${provider} requires config.endpoint (${provider} API URL)`);
    }
  }

  const uxcAuth = asString(config.uxcAuth) ?? asString(config.auth);
  if (!uxcAuth || uxcAuth.trim().length === 0) {
    throw new Error("email_mailbox requires config.uxcAuth (UXC auth profile name; credentials stay in UXC)");
  }

  const pollIntervalRaw = config.pollIntervalSecs;
  let pollIntervalSecs = EMAIL_MAILBOX_DEFAULT_POLL_INTERVAL_SECS;
  if (pollIntervalRaw !== undefined && pollIntervalRaw !== null) {
    const parsed = numberFromUnknown(pollIntervalRaw);
    if (parsed === undefined || !Number.isInteger(parsed) || parsed < 15) {
      throw new Error(`email_mailbox config.pollIntervalSecs must be an integer >= 15; got ${String(pollIntervalRaw)}`);
    }
    pollIntervalSecs = parsed;
  }

  const smtpEndpoint = asString(config.smtpEndpoint);
  if (smtpEndpoint && !/^smtp:\/\/./i.test(smtpEndpoint)) {
    throw new Error(`email_mailbox config.smtpEndpoint must use smtp:// (uxc SMTP surface); got ${smtpEndpoint}`);
  }

  const fromAddress = asString(config.fromAddress);
  if (fromAddress && !fromAddress.includes("@")) {
    throw new Error(`email_mailbox config.fromAddress must be an email address; got ${fromAddress}`);
  }

  const account = asString(config.account) ?? undefined;
  if (account !== undefined && account.trim().length === 0) {
    throw new Error("email_mailbox config.account must be a non-empty string when provided");
  }

  const mailbox = asString(config.mailbox) ?? EMAIL_DEFAULT_MAILBOX;
  if (mailbox.trim().length === 0) {
    throw new Error("email_mailbox config.mailbox must be a non-empty string when provided");
  }

  const addressAllowlist = asStringArray(config.addressAllowlist ?? config.addressAllowList);

  return {
    provider: provider as EmailMailboxProvider,
    endpoint,
    uxcAuth: uxcAuth.trim(),
    account: account?.trim() || undefined,
    mailbox,
    pollIntervalSecs,
    ...(smtpEndpoint ? { smtpEndpoint } : {}),
    ...(fromAddress ? { fromAddress } : {}),
    ...(addressAllowlist && addressAllowlist.length > 0 ? { addressAllowlist } : {}),
  };
}

export function buildEmailMailboxSourceSpec(config: EmailMailboxSourceConfig): ManagedSourceSpec {
  const args = compactRecord({
    mailbox: config.mailbox,
    account: config.account,
  });
  if (config.provider === "imap") {
    return {
      endpoint: config.endpoint,
      mode: "stream",
      transport_hint: "email_imap_idle",
      args,
      options: {
        auth: config.uxcAuth,
        artifact_compaction: false,
      },
    };
  }
  return {
    endpoint: config.endpoint,
    mode: "poll",
    transport_hint: "email_provider_poll",
    args: {
      provider: config.provider,
      ...args,
    },
    poll_config: {
      interval_secs: config.pollIntervalSecs,
      extract_items_pointer: "/items",
      checkpoint_strategy: {
        type: "item_key",
        item_key_pointer: "/message/uid",
      },
    },
    options: {
      auth: config.uxcAuth,
      artifact_compaction: false,
    },
  };
}

interface EmailActorParts {
  address: string | null;
  name: string | null;
  raw: string;
}

function emailActorParts(value: unknown): EmailActorParts | null {
  if (typeof value === "string") {
    const raw = value.trim();
    if (raw.length === 0) {
      return null;
    }
    const angled = raw.match(/<([^>]+)>\s*$/);
    if (angled) {
      const name = raw.slice(0, raw.lastIndexOf("<")).trim().replace(/^"|"$/g, "").trim();
      return { address: angled[1].trim(), name: name.length > 0 ? name : null, raw };
    }
    return { address: raw, name: null, raw };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.raw === "string") {
    return emailActorParts(record.raw);
  }
  const address = asString(record.address) ?? asString(record.email);
  if (address) {
    return { address, name: asString(record.name), raw: address };
  }
  return null;
}

function emailActorAddresses(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const addresses: string[] = [];
  for (const item of value) {
    const parts = emailActorParts(item);
    if (parts?.address) {
      addresses.push(parts.address);
    }
  }
  return addresses;
}

function emailActorList(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => emailActorParts(item))
    .filter((parts): parts is EmailActorParts => Boolean(parts?.address))
    .map((parts) => ({
      address: parts.address as string,
      ...(parts.name ? { name: parts.name } : {}),
    }));
}

export function normalizeEmailMailboxEvent(
  source: SourceStream,
  config: EmailMailboxSourceConfig,
  raw: unknown,
): AppendSourceEventInput | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const payload = raw as Record<string, unknown>;
  if (payload.type !== EMAIL_EVENT_TYPE) {
    return null;
  }
  const version = asString(payload.version);
  if (version !== null && version !== EMAIL_EVENT_VERSION) {
    return null;
  }
  if (payload.event_kind !== "message_received") {
    return null;
  }
  const message = asRecord(payload.message);
  if (Object.keys(message).length === 0) {
    return null;
  }

  const provider = asString(payload.provider) ?? config.provider;
  const account = asString(payload.account) ?? config.account ?? config.uxcAuth;
  const mailbox = asString(payload.mailbox) ?? config.mailbox;
  const uid = stringFromUnknown(message.uid);
  const messageId = asString(message.message_id) ?? uid;
  if (!uid && !messageId) {
    return null;
  }

  const fromParts = emailActorParts(message.from);
  const toAddresses = emailActorAddresses(message.to);
  if (
    config.addressAllowlist &&
    config.addressAllowlist.length > 0 &&
    !addressMatchesAllowlist(config.addressAllowlist, fromParts?.address ?? null, toAddresses)
  ) {
    return null;
  }

  const attachments = Array.isArray(message.attachments)
    ? message.attachments.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    : [];
  const attachmentCountRaw = message.attachment_count;
  const attachmentCount = numberFromUnknown(attachmentCountRaw) ?? null;

  const date = asString(message.date);
  return {
    sourceId: source.sourceId,
    sourceNativeId: `email:${provider}:${account}:${mailbox}:${uid ?? messageId}`,
    eventVariant: "email.message.received",
    occurredAt: occurredAtFromEmailDate(date),
    metadata: {
      provider,
      account,
      mailbox,
      messageId: messageId ?? null,
      providerMessageId: uid ?? null,
      threadId: asString(message.thread_id),
      from: fromParts ? (fromParts.address ?? fromParts.raw) : null,
      fromName: fromParts?.name ?? null,
      to: emailActorList(message.to),
      cc: emailActorList(message.cc),
      subject: asString(message.subject),
      textPreview: asString(message.snippet),
      date,
      hasAttachments: attachments.length > 0 || message.has_attachments === true,
      attachmentCount,
      attachments,
    },
    rawPayload: payload,
    deliveryHandle: {
      provider: "email",
      surface: "message_reply",
      targetRef: fromParts ? (fromParts.address ?? fromParts.raw) : "",
      threadRef: messageId ?? null,
      replyMode: "reply",
    },
  };
}

function addressMatchesAllowlist(allowlist: string[], fromAddress: string | null, toAddresses: string[]): boolean {
  const normalized = allowlist
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
  if (normalized.length === 0) {
    return true;
  }
  const lowerFrom = fromAddress?.toLowerCase() ?? null;
  if (lowerFrom && normalized.includes(lowerFrom)) {
    return true;
  }
  return toAddresses.some((address) => normalized.includes(address.toLowerCase()));
}

function occurredAtFromEmailDate(date: string | null): string {
  if (date) {
    const parsed = Date.parse(date);
    if (Number.isFinite(parsed)) {
      return new Date(parsed).toISOString();
    }
  }
  return new Date().toISOString();
}

export interface EmailUxcSendResult {
  smtp_url?: string;
  from?: string;
  to?: string[];
  subject?: string;
  message_id?: string;
  in_reply_to?: string | null;
  references?: string[];
  dry_run?: boolean;
  accepted_recipients?: number;
}

export interface EmailUxcCallClient {
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
}

export class RpcEmailUxcClient implements EmailUxcCallClient {
  constructor(private readonly client: Pick<EmailUxcCallClient, "request"> = new UxcDaemonClient({ env: process.env })) {}

  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    return this.client.request<T>(method, params);
  }
}

export interface EmailDeliveryRuntimeOptions {
  source?: SourceStream | null;
  client?: EmailUxcCallClient;
}

export function emailDeliveryOperationsForHandle(handle: DeliveryHandle): DeliveryOperationDescriptor[] {
  if (handle.provider !== "email") {
    return [];
  }
  if (handle.surface !== "message_reply" && handle.surface !== "message_send") {
    return [];
  }
  const isReply = handle.surface === "message_reply";
  const commonProperties: Record<string, unknown> = {
    text: { type: "string", minLength: 1 },
    subject: { type: "string", minLength: 1 },
    to: { type: "array", items: { type: "string", minLength: 1 } },
    cc: { type: "array", items: { type: "string", minLength: 1 } },
    from: { type: "string", minLength: 1 },
    smtpEndpoint: { type: "string", minLength: 1 },
    uxcAuth: { type: "string", minLength: 1 },
    correlationKey: { type: "string", minLength: 1 },
  };
  const operations: DeliveryOperationDescriptor[] = [
    {
      name: "send_text",
      title: isReply ? "Reply With Text" : "Send Text Email",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["text", "subject"],
        properties: commonProperties,
      },
      canonicalTextAlias: true,
    },
  ];
  if (isReply) {
    operations.push({
      name: "reply_text",
      title: "Reply With Text (Threaded)",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["text"],
        properties: {
          ...commonProperties,
          replyAll: { type: "boolean" },
          inReplyTo: { type: "string", minLength: 1 },
        },
      },
    });
  }
  return operations;
}

export async function invokeEmailDeliveryOperation(
  handle: DeliveryHandle,
  operation: string,
  input: Record<string, unknown>,
  options?: EmailDeliveryRuntimeOptions,
): Promise<{ status: DeliveryAttempt["status"]; note: string }> {
  if (handle.provider !== "email") {
    throw new Error(`email delivery operation requires an email handle, got ${handle.provider}`);
  }
  if (operation !== "send_text" && operation !== "reply_text") {
    throw new Error(`unknown email delivery operation: ${operation}`);
  }
  const isReply = operation === "reply_text" || handle.surface === "message_reply";

  const text = asString(input.text);
  if (!text || text.trim().length === 0) {
    throw new Error(`${operation} requires input.text`);
  }

  const config = sourceConfigOrNull(options?.source);
  const to = asStringArray(input.to) ?? (handle.targetRef ? [handle.targetRef] : []);
  const cc = asStringArray(input.cc) ?? [];
  if (to.length === 0 && cc.length === 0) {
    throw new Error(`${operation} requires at least one recipient in input.to (or input.cc)`);
  }

  const subject = resolveEmailSubject(operation, input, isReply);
  const smtpEndpoint = asString(input.smtpEndpoint) ?? config?.smtpEndpoint ?? null;
  if (!smtpEndpoint) {
    throw new Error(`${operation} requires input.smtpEndpoint or source config smtpEndpoint (uxc supports smtp://)`);
  }
  const from = asString(input.from) ?? config?.fromAddress ?? addressLikeAccount(config?.account) ?? null;
  if (!from) {
    throw new Error(`${operation} requires input.from, source config fromAddress, or an account-like config.account value`);
  }
  const uxcAuth = asString(input.uxcAuth) ?? config?.uxcAuth ?? null;

  const correlationKey = asString(input.correlationKey);
  const inReplyTo = asString(input.inReplyTo) ?? (isReply ? handle.threadRef ?? null : null);

  const params = compactRecord({
    smtp_url: smtpEndpoint,
    from,
    to,
    cc: cc.length > 0 ? cc : undefined,
    subject,
    text,
    in_reply_to: inReplyTo ?? undefined,
    auth: uxcAuth ?? undefined,
    message_id: correlationKey ? correlationMessageId(correlationKey) : undefined,
  });

  const method = isReply ? "email.reply" : "email.send";
  if (isReply) {
    params.reply_handle = compactRecord({
      message_id: handle.threadRef ?? undefined,
      account: config?.account ?? undefined,
      mailbox: config?.mailbox ?? undefined,
    });
  }

  const client = options?.client ?? new RpcEmailUxcClient();
  let result: EmailUxcSendResult;
  try {
    result = await client.request<EmailUxcSendResult>(method, params);
  } catch (error) {
    throw wrapEmailRpcError(error, method);
  }

  const note = isReply
    ? `sent email reply${result.message_id ? ` (message-id ${result.message_id})` : ""}`
    : `sent email${result.message_id ? ` (message-id ${result.message_id})` : ""}`;
  return { status: "sent", note };
}

function resolveEmailSubject(
  operation: string,
  input: Record<string, unknown>,
  isReply: boolean,
): string {
  const subject = asString(input.subject);
  if (!isReply) {
    if (!subject || subject.trim().length === 0) {
      throw new Error(`${operation} requires input.subject`);
    }
    return subject;
  }
  const base = subject && subject.trim().length > 0 ? subject.trim() : "your message";
  if (/^re:/i.test(base)) {
    return base;
  }
  return `Re: ${base}`;
}

function correlationMessageId(correlationKey: string): string {
  const trimmed = correlationKey.trim();
  if (trimmed.startsWith("<") && trimmed.endsWith(">")) {
    return trimmed;
  }
  const safe = trimmed.replace(/[<>\s]/g, "");
  return `<agentinbox-${safe}@localhost>`;
}

function sourceConfigOrNull(source: SourceStream | null | undefined): EmailMailboxSourceConfig | null {
  if (!source || source.sourceType !== "email_mailbox") {
    return null;
  }
  try {
    return parseEmailMailboxSourceConfig(source);
  } catch {
    return null;
  }
}

function addressLikeAccount(account: string | undefined): string | null {
  if (!account) {
    return null;
  }
  return account.includes("@") ? account : null;
}

function wrapEmailRpcError(error: unknown, method: string): Error {
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (code === -32601 || code === -32602) {
      return new Error(
        `connected uxc daemon does not support ${method} (code ${code}); upgrade uxc to a version with email send/reply RPC support`,
      );
    }
  }
  return error instanceof Error ? error : new Error(String(error));
}

export class EmailDeliveryAdapter {
  private readonly client: EmailUxcCallClient;

  constructor(client?: EmailUxcCallClient) {
    this.client = client ?? new RpcEmailUxcClient();
  }

  async send(request: DeliveryRequest, attempt: DeliveryAttempt): Promise<{ status: "sent"; note: string }> {
    const handle: DeliveryHandle = {
      provider: attempt.provider,
      surface: attempt.surface,
      targetRef: attempt.targetRef,
      threadRef: attempt.threadRef ?? null,
      replyMode: attempt.replyMode ?? null,
    };
    const result = await invokeEmailDeliveryOperation(handle, "send_text", request.payload, {
      client: this.client,
    });
    return { status: "sent" as const, note: result.note };
  }
}

function compactRecord(input: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === null) {
      continue;
    }
    if (Array.isArray(value) && value.length === 0) {
      continue;
    }
    output[key] = value;
  }
  return output;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asStringArray(value: unknown): string[] | null {
  if (Array.isArray(value)) {
    return value
      .map((item) => stringFromUnknown(item))
      .filter((item): item is string => Boolean(item && item.trim().length > 0));
  }
  if (typeof value === "string") {
    return value
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
  }
  return null;
}

function stringFromUnknown(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  return null;
}

function numberFromUnknown(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}
