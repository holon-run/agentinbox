import crypto from "node:crypto";
import { UxcDaemonClient } from "@holon-run/uxc-daemon-client";
import type {
  EmailBodyCacheRecord,
  EmailBodyCompleteness,
  EmailBodyOrigin,
  EmailBodyReadResult,
  InboxItemEntry,
  SourceStream,
} from "./model";
import { AgentInboxStore } from "./store";
import { nowIso } from "./util";

export const EMAIL_BODY_DEFAULT_MAX_BYTES = 32 * 1024;
export const EMAIL_BODY_MAX_BYTES = 1024 * 1024;
const EMAIL_BODY_CACHE_MAX_BYTES = 128 * 1024 * 1024;
const EMAIL_BODY_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const EMAIL_BODY_SCHEMA_VERSION = 1;

export interface EmailBodyReadOptions {
  maxBytes?: number;
  fetch?: boolean;
  cursor?: string;
}

type EmailBodyInput =
  | { kind: "inline_mime"; mimeBase64: string; originalBytes: number; complete: boolean }
  | { kind: "legacy_mime"; mimeText: string; sourceTruncated?: boolean }
  | { kind: "message_ref"; messageRef: string };

export interface EmailBodyUxcClient {
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
}

interface BodySnapshot {
  contentVersion: string;
  schemaVersion: number;
  parserVersion: string;
  text: string;
  bytes: number;
  completeness: EmailBodyCompleteness;
  reasons: string[];
  origin: EmailBodyOrigin;
}

type UnavailableEmailBodyRead = Extract<EmailBodyReadResult, { status: "unavailable" }>;

interface CursorPayload {
  v: 1;
  inboxId: string;
  entryId: string;
  snapshotVersion: string;
  offset: number;
}

export class EmailBodyReader {
  private readonly inFlight = new Map<string, Promise<BodySnapshot | EmailBodyReadResult>>();
  private readonly cursorSecret = crypto.randomBytes(32);

  constructor(
    private readonly store: AgentInboxStore,
    private readonly uxc: EmailBodyUxcClient = new UxcDaemonClient({ env: process.env }),
  ) {}

  async read(
    inboxId: string,
    entry: InboxItemEntry,
    source: SourceStream,
    options: EmailBodyReadOptions = {},
  ): Promise<EmailBodyReadResult> {
    const maxBytes = options.maxBytes ?? EMAIL_BODY_DEFAULT_MAX_BYTES;
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > EMAIL_BODY_MAX_BYTES) {
      throw new Error(`email body max_bytes must be an integer between 1 and ${EMAIL_BODY_MAX_BYTES}`);
    }
    if (source.sourceType !== "email_mailbox" || entry.eventVariant !== "email.message.received") {
      return unavailable(entry.entryId, "unsupported", false, "This inbox entry is not a supported email message.");
    }

    const contentVersion = emailBodyContentVersion(entry);
    const cursor = options.cursor
      ? decodeCursor(options.cursor, inboxId, entry.entryId, this.cursorSecret)
      : null;
    if (cursor) {
      const cached = this.store.getEmailBodyCache(inboxId, entry.entryId);
      if (
        !cached ||
        cached.contentVersion !== contentVersion ||
        cached.expiresAt <= nowIso()
      ) {
        throw new Error("email body cursor is invalid or expired");
      }
      const snapshot = snapshotFromCache(cached);
      if (snapshotVersion(snapshot) !== cursor.snapshotVersion) {
        throw new Error("email body cursor is invalid or expired");
      }
      this.store.touchEmailBodyCache(entry.entryId, nowIso());
      return {
        status: "available",
        entryId: entry.entryId,
        subject: optionalString(entry.metadata?.subject),
        from: optionalString(entry.metadata?.from),
        attachments: publicAttachments(entry.metadata?.attachments),
        body: pageSnapshot(snapshot, maxBytes, cursor.offset, inboxId, entry.entryId, this.cursorSecret),
      };
    }
    const snapshot = await this.resolveSnapshot(
      inboxId,
      entry,
      source,
      contentVersion,
      options.fetch !== false,
    );
    if ("status" in snapshot) {
      return snapshot;
    }

    return {
      status: "available",
      entryId: entry.entryId,
      subject: optionalString(entry.metadata?.subject),
      from: optionalString(entry.metadata?.from),
      attachments: publicAttachments(entry.metadata?.attachments),
      body: pageSnapshot(snapshot, maxBytes, 0, inboxId, entry.entryId, this.cursorSecret),
    };
  }

  private async resolveSnapshot(
    inboxId: string,
    entry: InboxItemEntry,
    source: SourceStream,
    contentVersion: string,
    allowFetch: boolean,
  ): Promise<BodySnapshot | EmailBodyReadResult> {
    const now = nowIso();
    const cached = this.store.getEmailBodyCache(inboxId, entry.entryId);
    if (
      cached &&
      cached.contentVersion === contentVersion &&
      cached.expiresAt > now &&
      (cached.completeness === "complete" || !allowFetch)
    ) {
      this.store.touchEmailBodyCache(entry.entryId, now);
      return snapshotFromCache(cached);
    }

    const key = `${inboxId}:${entry.entryId}:${contentVersion}:${allowFetch ? "fetch" : "local"}`;
    const existing = this.inFlight.get(key);
    if (existing) {
      return existing;
    }
    const pending = this.loadSnapshot(inboxId, entry, source, contentVersion, allowFetch, cached)
      .finally(() => {
        this.inFlight.delete(key);
      });
    this.inFlight.set(key, pending);
    return pending;
  }

  private async loadSnapshot(
    inboxId: string,
    entry: InboxItemEntry,
    source: SourceStream,
    contentVersion: string,
    allowFetch: boolean,
    cached: EmailBodyCacheRecord | null,
  ): Promise<BodySnapshot | EmailBodyReadResult> {
    const payload = entry.rawPayload ?? {};
    const local = await this.readLocal(payload);
    if (local?.completeness === "complete") {
      return this.cacheSnapshot(inboxId, entry, contentVersion, local, "local");
    }

    const messageRef = optionalString(payload.message_ref);
    if (allowFetch && messageRef) {
      const fetched = await this.callUxc({ kind: "message_ref", messageRef });
      if (!isUnavailable(fetched)) {
        return this.cacheSnapshot(inboxId, entry, contentVersion, fetched, "fetched");
      }
      if (local) {
        return this.cacheSnapshot(inboxId, entry, contentVersion, {
          ...local,
          reasons: uniqueStrings([...local.reasons, `fetch_${fetched.code}`]),
        }, "local");
      }
      if (
        cached &&
        cached.contentVersion === contentVersion &&
        cached.expiresAt > nowIso()
      ) {
        return snapshotFromCache(cached);
      }
      return { ...fetched, entryId: entry.entryId };
    }

    if (local) {
      return this.cacheSnapshot(inboxId, entry, contentVersion, local, "local");
    }
    if (cached && cached.contentVersion === contentVersion && cached.expiresAt > nowIso()) {
      return snapshotFromCache(cached);
    }
    return {
      status: "unavailable",
      entryId: entry.entryId,
      code: allowFetch ? (messageRef ? "provider_unavailable" : "identity_missing") : "local_body_unavailable",
      retryable: allowFetch && Boolean(messageRef),
      message: allowFetch
        ? "No readable email body is available for this entry."
        : "No local email body is available; retry without --no-fetch.",
    };
  }

  private async readLocal(payload: Record<string, unknown>): Promise<BodySnapshot | null> {
    const embedded = bodyResultFromUnknown(payload.body);
    if (embedded) {
      return { ...embedded, contentVersion: "", origin: "local" };
    }
    const raw = objectValue(payload.raw);
    const mimeBase64 = optionalString(raw.mime_inline_base64);
    const originalBytes = optionalInteger(raw.original_bytes);
    if (mimeBase64 && originalBytes != null) {
      const result = await this.callUxc({
        kind: "inline_mime",
        mimeBase64,
        originalBytes,
        complete: raw.complete === true,
      });
      return isUnavailable(result) ? null : result;
    }
    const mimeText = optionalString(raw.mime_inline);
    if (mimeText != null) {
      const result = await this.callUxc({
        kind: "legacy_mime",
        mimeText,
        sourceTruncated: raw.mime_truncated === true,
      });
      return isUnavailable(result) ? null : result;
    }
    return null;
  }

  private async callUxc(input: EmailBodyInput): Promise<BodySnapshot | UnavailableEmailBodyRead> {
    try {
      const status = objectValue(await this.uxc.request("daemon.status"));
      const capability = objectValue(status.email_body);
      const inputKinds = Array.isArray(capability.input_kinds) ? capability.input_kinds : [];
      if (
        capability.schema_version !== EMAIL_BODY_SCHEMA_VERSION ||
        !inputKinds.includes(input.kind)
      ) {
        return unavailable("", "capability_unavailable", false, "The installed UXC daemon does not support this email body input.");
      }
      const result = await this.uxc.request("email.body.read", {
        input: emailBodyInputParams(input),
      });
      const parsed = bodyResultFromUnknown(result);
      if (!parsed) {
        return unavailable("", "parse_failed", false, "UXC returned an invalid email body result.");
      }
      return { ...parsed, contentVersion: "", origin: input.kind === "message_ref" ? "fetched" : "local" };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const timeout = /timed out|timeout/i.test(message);
      return unavailable(
        "",
        timeout ? "timeout" : "provider_unavailable",
        true,
        timeout ? "Email body retrieval timed out." : "Email body retrieval is temporarily unavailable.",
      );
    }
  }

  private cacheSnapshot(
    inboxId: string,
    entry: InboxItemEntry,
    contentVersion: string,
    snapshot: BodySnapshot,
    origin: EmailBodyOrigin,
  ): BodySnapshot | EmailBodyReadResult {
    if (!this.store.getInboxEntryForInbox(inboxId, entry.entryId)) {
      return unavailable(entry.entryId, "not_found", false, "The inbox entry is no longer available.");
    }
    const now = nowIso();
    const normalized: BodySnapshot = { ...snapshot, contentVersion, origin };
    this.store.putEmailBodyCache({
      entryId: entry.entryId,
      inboxId,
      itemId: entry.itemId,
      sourceId: entry.sourceId!,
      contentVersion,
      schemaVersion: snapshot.schemaVersion,
      parserVersion: snapshot.parserVersion,
      text: snapshot.text,
      bytes: snapshot.bytes,
      completeness: snapshot.completeness,
      reasons: snapshot.reasons,
      createdAt: now,
      expiresAt: new Date(Date.parse(now) + EMAIL_BODY_CACHE_TTL_MS).toISOString(),
      lastAccessedAt: now,
    }, EMAIL_BODY_CACHE_MAX_BYTES);
    return normalized;
  }
}

function bodyResultFromUnknown(value: unknown): Omit<BodySnapshot, "contentVersion" | "origin"> | null {
  const result = objectValue(value);
  const completeness = result.completeness;
  if (
    result.schema_version !== EMAIL_BODY_SCHEMA_VERSION ||
    typeof result.parser_version !== "string" ||
    result.format !== "text" ||
    typeof result.text !== "string" ||
    !Number.isSafeInteger(result.bytes) ||
    (completeness !== "complete" && completeness !== "partial" && completeness !== "unverified") ||
    !Array.isArray(result.reasons)
  ) {
    return null;
  }
  const actualBytes = Buffer.byteLength(result.text, "utf8");
  if (actualBytes !== result.bytes || actualBytes > EMAIL_BODY_MAX_BYTES) {
    return null;
  }
  return {
    schemaVersion: EMAIL_BODY_SCHEMA_VERSION,
    parserVersion: result.parser_version,
    text: result.text,
    bytes: actualBytes,
    completeness,
    reasons: result.reasons.filter((reason): reason is string => typeof reason === "string"),
  };
}

function snapshotFromCache(cache: EmailBodyCacheRecord): BodySnapshot {
  return {
    contentVersion: cache.contentVersion,
    schemaVersion: cache.schemaVersion,
    parserVersion: cache.parserVersion,
    text: cache.text,
    bytes: cache.bytes,
    completeness: cache.completeness,
    reasons: cache.reasons,
    origin: "cache",
  };
}

function pageSnapshot(
  snapshot: BodySnapshot,
  maxBytes: number,
  offset: number,
  inboxId: string,
  entryId: string,
  cursorSecret: Buffer,
) {
  const full = Buffer.from(snapshot.text, "utf8");
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > full.length || !isUtf8Boundary(full, offset)) {
    throw new Error("email body cursor is invalid or expired");
  }
  let end = Math.min(full.length, offset + maxBytes);
  while (end > offset && !isUtf8Boundary(full, end)) {
    end -= 1;
  }
  if (end === offset && offset < full.length) {
    let next = offset + 1;
    while (next < full.length && !isUtf8Boundary(full, next)) {
      next += 1;
    }
    throw new Error(`email body max_bytes is too small; at least ${next - offset} bytes are required for the next character`);
  }
  const hasMore = end < full.length;
  const nextCursor = hasMore
    ? encodeCursor({
        v: 1,
        inboxId,
        entryId,
        snapshotVersion: snapshotVersion(snapshot),
        offset: end,
      }, cursorSecret)
    : undefined;
  return {
    format: "text" as const,
    text: full.subarray(offset, end).toString("utf8"),
    returnedBytes: end - offset,
    completeness: snapshot.completeness,
    reasons: snapshot.reasons,
    hasMore,
    ...(nextCursor ? { nextCursor } : {}),
    truncated: hasMore || snapshot.completeness !== "complete",
    ...(snapshot.completeness === "complete" ? { totalBytes: snapshot.bytes } : {}),
    origin: snapshot.origin,
  };
}

function emailBodyContentVersion(entry: InboxItemEntry): string {
  const payload = entry.rawPayload ?? {};
  const raw = objectValue(payload.raw);
  const message = objectValue(payload.message);
  return crypto.createHash("sha256").update(JSON.stringify({
    itemId: entry.itemId,
    stableKey: message.stable_key ?? null,
    messageRef: payload.message_ref ?? null,
    body: payload.body ?? null,
    rawRepresentation: raw.representation_version ?? null,
    rawOriginalBytes: raw.original_bytes ?? raw.size_bytes ?? null,
    rawComplete: raw.complete ?? null,
    mimeBase64: raw.mime_inline_base64 ?? null,
    legacyMime: raw.mime_inline ?? null,
    legacyTruncated: raw.mime_truncated ?? null,
  })).digest("base64url");
}

function encodeCursor(cursor: CursorPayload, cursorSecret: Buffer): string {
  const payload = Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
  return `${payload}.${signCursor(payload, cursorSecret)}`;
}

function decodeCursor(
  token: string,
  inboxId: string,
  entryId: string,
  cursorSecret: Buffer,
): CursorPayload {
  try {
    const [payload, signature, extra] = token.split(".");
    if (!payload || !signature || extra || !validCursorSignature(payload, signature, cursorSecret)) {
      throw new Error("invalid");
    }
    const value = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Partial<CursorPayload>;
    if (
      value.v !== 1 ||
      value.inboxId !== inboxId ||
      value.entryId !== entryId ||
      typeof value.snapshotVersion !== "string" ||
      !Number.isSafeInteger(value.offset) ||
      value.offset! < 0
    ) {
      throw new Error("invalid");
    }
    return value as CursorPayload;
  } catch {
    throw new Error("email body cursor is invalid or expired");
  }
}

function signCursor(payload: string, cursorSecret: Buffer): string {
  return crypto.createHmac("sha256", cursorSecret).update(payload).digest("base64url");
}

function validCursorSignature(payload: string, signature: string, cursorSecret: Buffer): boolean {
  const expected = Buffer.from(signCursor(payload, cursorSecret), "base64url");
  const actual = Buffer.from(signature, "base64url");
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function snapshotVersion(snapshot: BodySnapshot): string {
  return crypto.createHash("sha256").update(JSON.stringify({
    parserVersion: snapshot.parserVersion,
    text: snapshot.text,
    completeness: snapshot.completeness,
    reasons: snapshot.reasons,
  })).digest("base64url");
}

function emailBodyInputParams(input: EmailBodyInput): Record<string, unknown> {
  switch (input.kind) {
    case "inline_mime":
      return {
        kind: input.kind,
        mime_base64: input.mimeBase64,
        original_bytes: input.originalBytes,
        complete: input.complete,
      };
    case "legacy_mime":
      return {
        kind: input.kind,
        mime_text: input.mimeText,
        ...(input.sourceTruncated === undefined ? {} : { source_truncated: input.sourceTruncated }),
      };
    case "message_ref":
      return {
        kind: input.kind,
        message_ref: input.messageRef,
      };
  }
}

function isUnavailable(
  value: BodySnapshot | UnavailableEmailBodyRead,
): value is UnavailableEmailBodyRead {
  return "status" in value && value.status === "unavailable";
}

function isUtf8Boundary(buffer: Buffer, offset: number): boolean {
  return offset === 0 || offset === buffer.length || (buffer[offset] & 0b1100_0000) !== 0b1000_0000;
}

function unavailable(
  entryId: string,
  code: string,
  retryable: boolean,
  message: string,
): UnavailableEmailBodyRead {
  return { status: "unavailable", entryId, code, retryable, message };
}

function publicAttachments(value: unknown): Array<{
  filename?: string | null;
  contentType?: string | null;
  size?: number | null;
}> {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item) => {
    const attachment = objectValue(item);
    if (Object.keys(attachment).length === 0) {
      return [];
    }
    return [{
      filename: optionalString(attachment.filename),
      contentType: optionalString(attachment.content_type) ?? optionalString(attachment.contentType),
      size: optionalInteger(attachment.size),
    }];
  });
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function optionalInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}
