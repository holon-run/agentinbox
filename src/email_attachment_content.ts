import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { UxcDaemonClient } from "@holon-run/uxc-daemon-client";
import {
  publicEmailAttachmentCollection,
  resolveEmailAttachment,
} from "./email_attachment";
import type {
  EmailAttachmentMaterialization,
  InboxItem,
  PublicEmailAttachment,
  SourceStream,
} from "./model";
import { parseEmailAttachmentPolicy } from "./sources/email";
import { AgentInboxStore } from "./store";
import { nowIso } from "./util";

export interface EmailAttachmentUxcClient {
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
}

export interface EmailAttachmentContent {
  attachment: PublicEmailAttachment;
  stream: fs.ReadStream;
  size: number;
  sha256: string;
  contentType: string;
}

interface UxcAttachmentResult {
  size_bytes: number;
  sha256: string;
  content_type?: string | null;
}

interface OwnedAttachment {
  inboxId: string;
  item: InboxItem;
  source: SourceStream;
  attachmentSelector: string;
  attachment: PublicEmailAttachment;
  handle: Record<string, unknown> | null;
}

class EmailAttachmentError extends Error {
  readonly statusCode: number;

  constructor(
    readonly code: string,
    readonly rejected: boolean,
    message: string,
  ) {
    super(message);
    this.statusCode = code === "attachment_content_unavailable"
      ? 404
      : rejected
        ? 400
        : 503;
  }
}

export class EmailAttachmentContentManager {
  private readonly inFlight = new Map<string, Promise<PublicEmailAttachment>>();
  private readonly itemInFlight = new Map<string, Promise<void>>();
  private readonly stagingDir: string;
  private readonly objectsDir: string;

  constructor(
    private readonly store: AgentInboxStore,
    rootDir: string,
    private readonly uxc: EmailAttachmentUxcClient = new UxcDaemonClient({ env: process.env }),
  ) {
    this.stagingDir = path.join(rootDir, "staging");
    this.objectsDir = path.join(rootDir, "objects");
  }

  inspect(agentId: string, attachmentRef: string): PublicEmailAttachment {
    return this.resolveOwned(agentId, attachmentRef).attachment;
  }

  async materialize(agentId: string, attachmentRef: string): Promise<PublicEmailAttachment> {
    const owned = this.resolveOwned(agentId, attachmentRef);
    const current = this.store.getEmailAttachmentMaterialization(
      owned.item.itemId,
      owned.attachmentSelector,
    );
    if (current?.status === "available" && current.objectKey && this.objectExists(current.objectKey)) {
      return this.resolveOwned(agentId, attachmentRef).attachment;
    }

    const key = `${owned.inboxId}:${owned.item.itemId}:${owned.attachmentSelector}`;
    const existing = this.inFlight.get(key);
    if (existing) {
      return existing;
    }
    const itemKey = `${owned.inboxId}:${owned.item.itemId}`;
    const previousItem = this.itemInFlight.get(itemKey) ?? Promise.resolve();
    const pending = previousItem
      .catch(() => undefined)
      .then(() => this.materializeOnce(agentId, attachmentRef, owned))
      .finally(() => this.inFlight.delete(key));
    const itemCompletion = pending.then(
      () => undefined,
      () => undefined,
    ).finally(() => {
      if (this.itemInFlight.get(itemKey) === itemCompletion) {
        this.itemInFlight.delete(itemKey);
      }
    });
    this.itemInFlight.set(itemKey, itemCompletion);
    this.inFlight.set(key, pending);
    return pending;
  }

  openContent(agentId: string, attachmentRef: string): EmailAttachmentContent {
    const owned = this.resolveOwned(agentId, attachmentRef);
    const materialization = this.store.getEmailAttachmentMaterialization(
      owned.item.itemId,
      owned.attachmentSelector,
    );
    if (
      materialization?.status !== "available"
      || !materialization.objectKey
      || !materialization.sha256
      || materialization.storedSize == null
    ) {
      throw new EmailAttachmentError(
        "attachment_content_unavailable",
        false,
        "Email attachment content is not available.",
      );
    }
    const objectPath = this.resolveObjectPath(materialization.objectKey);
    let fd: number | null = null;
    try {
      fd = fs.openSync(objectPath, "r");
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size !== materialization.storedSize) {
        throw new Error("managed attachment object mismatch");
      }
    } catch {
      if (fd != null) {
        fs.closeSync(fd);
      }
      throw new EmailAttachmentError(
        "attachment_content_unavailable",
        false,
        "Email attachment content is not available.",
      );
    }
    if (fd == null) {
      throw new EmailAttachmentError(
        "attachment_content_unavailable",
        false,
        "Email attachment content is not available.",
      );
    }
    let verified: OwnedAttachment;
    try {
      // Re-check ownership after opening the managed object and before returning bytes.
      verified = this.resolveOwned(agentId, attachmentRef);
    } catch (error) {
      fs.closeSync(fd);
      throw error;
    }
    return {
      attachment: verified.attachment,
      stream: fs.createReadStream(objectPath, { fd, autoClose: true }),
      size: materialization.storedSize,
      sha256: materialization.sha256,
      contentType: materialization.detectedContentType ?? "application/octet-stream",
    };
  }

  private async materializeOnce(
    agentId: string,
    attachmentRef: string,
    owned: OwnedAttachment,
  ): Promise<PublicEmailAttachment> {
    const policy = parseEmailAttachmentPolicy(
      owned.source.config?.attachmentPolicy ?? owned.source.config?.attachment_policy,
    );
    if (policy.mode !== "store_reference") {
      throw new EmailAttachmentError(
        "attachment_policy_metadata_only",
        true,
        "This email source does not allow attachment content storage.",
      );
    }
    if (!owned.handle) {
      throw new EmailAttachmentError(
        "attachment_not_retrievable",
        true,
        "This attachment does not have a retrievable provider reference.",
      );
    }

    const collection = publicEmailAttachmentCollection(owned.item.itemId, owned.item.metadata);
    const knownCount = collection.attachmentCount ?? collection.attachments.length;
    if (knownCount > policy.maxAttachmentsPerMessage) {
      throw new EmailAttachmentError(
        "attachment_count_limit_exceeded",
        true,
        "The message exceeds the configured attachment count limit.",
      );
    }
    if (
      owned.attachment.size != null
      && owned.attachment.size > policy.maxBytesPerAttachment
    ) {
      throw new EmailAttachmentError(
        "attachment_size_limit_exceeded",
        true,
        "The attachment exceeds the configured size limit.",
      );
    }
    assertContentTypeAllowed(owned.attachment.contentType, policy, "declared");
    const storedBeforeFetch = this.store.sumAvailableEmailAttachmentBytes(
      owned.item.itemId,
      owned.attachmentSelector,
    );
    if (
      owned.attachment.size != null
      && storedBeforeFetch + owned.attachment.size > policy.maxBytesPerMessage
    ) {
      throw new EmailAttachmentError(
        "attachment_message_size_limit_exceeded",
        true,
        "The message exceeds the configured stored attachment byte limit.",
      );
    }

    const now = nowIso();
    const prior = this.store.getEmailAttachmentMaterialization(
      owned.item.itemId,
      owned.attachmentSelector,
    );
    const pending: EmailAttachmentMaterialization = {
      itemId: owned.item.itemId,
      attachmentSelector: owned.attachmentSelector,
      status: "pending",
      lastErrorCode: null,
      objectKey: null,
      sha256: null,
      declaredContentType: owned.attachment.contentType,
      detectedContentType: null,
      declaredSize: owned.attachment.size,
      storedSize: null,
      createdAt: prior?.createdAt ?? now,
      updatedAt: now,
      expiresAt: null,
      deletedAt: null,
    };
    if (!this.store.beginEmailAttachmentMaterialization(owned.inboxId, pending)) {
      throw unknownAttachment(attachmentRef);
    }

    fs.mkdirSync(this.stagingDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(this.stagingDir, 0o700);
    const stagingPath = path.join(this.stagingDir, crypto.randomBytes(18).toString("hex"));

    try {
      const result = await this.retrieve(owned.handle, stagingPath, policy.maxBytesPerAttachment);
      const stat = fs.statSync(stagingPath);
      if (!stat.isFile() || stat.size > policy.maxBytesPerAttachment || stat.size !== result.size_bytes) {
        throw new EmailAttachmentError(
          "attachment_size_mismatch",
          true,
          "The retrieved attachment size did not match the provider result.",
        );
      }
      fs.chmodSync(stagingPath, 0o600);
      const sha256 = await hashFile(stagingPath);
      if (sha256 !== result.sha256.toLowerCase()) {
        throw new EmailAttachmentError(
          "attachment_hash_mismatch",
          true,
          "The retrieved attachment hash did not match the provider result.",
        );
      }
      const detectedContentType = detectContentType(stagingPath);
      assertContentTypeAllowed(detectedContentType, policy, "detected");
      const alreadyStored = this.store.sumAvailableEmailAttachmentBytes(
        owned.item.itemId,
        owned.attachmentSelector,
      );
      if (alreadyStored + stat.size > policy.maxBytesPerMessage) {
        throw new EmailAttachmentError(
          "attachment_message_size_limit_exceeded",
          true,
          "The message exceeds the configured stored attachment byte limit.",
        );
      }

      const verified = this.resolveOwned(agentId, attachmentRef);
      syncFile(stagingPath);
      const objectKey = await this.putObject(stagingPath, sha256);
      const completedAt = nowIso();
      const record: EmailAttachmentMaterialization = {
        ...pending,
        status: "available",
        objectKey,
        sha256,
        detectedContentType,
        storedSize: stat.size,
        updatedAt: completedAt,
        expiresAt: new Date(
          Date.parse(completedAt) + policy.retentionSecs * 1000,
        ).toISOString(),
      };
      if (
        verified.item.itemId !== owned.item.itemId
        || verified.attachmentSelector !== owned.attachmentSelector
        || !this.store.finishEmailAttachmentMaterialization(owned.inboxId, record)
      ) {
        throw unknownAttachment(attachmentRef);
      }
      return this.resolveOwned(agentId, attachmentRef).attachment;
    } catch (error) {
      fs.rmSync(stagingPath, { force: true });
      if (error instanceof Error && error.message.startsWith("unknown inbox attachment:")) {
        throw error;
      }
      const failure = attachmentFailure(error);
      const failedAt = nowIso();
      this.store.finishEmailAttachmentMaterialization(owned.inboxId, {
        ...pending,
        status: failure.rejected ? "rejected" : "failed",
        lastErrorCode: failure.code,
        updatedAt: failedAt,
      });
      throw failure;
    }
  }

  private async retrieve(
    handle: Record<string, unknown>,
    stagingPath: string,
    maxBytes: number,
  ): Promise<UxcAttachmentResult> {
    const result = await this.uxc.request<unknown>("email.attachment.get", {
      handle: JSON.stringify(handle),
      output: stagingPath,
      max_bytes: maxBytes,
    });
    if (!isRecord(result)) {
      throw new EmailAttachmentError(
        "attachment_provider_invalid_result",
        false,
        "UXC returned an invalid attachment result.",
      );
    }
    const size = optionalInteger(result.size_bytes);
    const sha256 = optionalString(result.sha256);
    if (size == null || !sha256 || !/^[a-f0-9]{64}$/i.test(sha256)) {
      throw new EmailAttachmentError(
        "attachment_provider_invalid_result",
        false,
        "UXC returned an invalid attachment result.",
      );
    }
    return {
      size_bytes: size,
      sha256: sha256.toLowerCase(),
      content_type: optionalString(result.content_type),
    };
  }

  private resolveOwned(agentId: string, attachmentRef: string): OwnedAttachment {
    const inbox = this.store.getInboxByAgentId(agentId);
    const parsed = inbox ? attachmentRefParts(attachmentRef) : null;
    const item = parsed && inbox
      ? this.store.getInboxItemForInbox(inbox.inboxId, parsed.itemId)
      : null;
    const source = item ? this.store.getSource(item.sourceId) : null;
    if (
      !inbox
      || !item
      || item.eventVariant !== "email.message.received"
      || source?.sourceType !== "email_mailbox"
    ) {
      throw unknownAttachment(attachmentRef);
    }
    const resolved = resolveEmailAttachment(
      item,
      attachmentRef,
      (itemId, selector) => this.store.getEmailAttachmentMaterialization(itemId, selector),
    );
    if (!resolved) {
      throw unknownAttachment(attachmentRef);
    }
    return {
      inboxId: inbox.inboxId,
      item,
      source,
      ...resolved,
    };
  }

  private async putObject(stagingPath: string, sha256: string): Promise<string> {
    const objectKey = path.posix.join("objects", sha256.slice(0, 2), sha256);
    const objectPath = this.resolveObjectPath(objectKey);
    fs.mkdirSync(path.dirname(objectPath), { recursive: true, mode: 0o700 });
    fs.chmodSync(path.dirname(objectPath), 0o700);
    if (fs.existsSync(objectPath)) {
      const stagedSize = fs.statSync(stagingPath).size;
      const existing = fs.statSync(objectPath);
      if (
        !existing.isFile()
        || existing.size !== stagedSize
        || await hashFile(objectPath) !== sha256
      ) {
        throw new EmailAttachmentError(
          "attachment_object_integrity_mismatch",
          false,
          "The managed attachment object failed integrity verification.",
        );
      }
      fs.rmSync(stagingPath, { force: true });
    } else {
      fs.renameSync(stagingPath, objectPath);
      fs.chmodSync(objectPath, 0o600);
      syncDirectory(path.dirname(objectPath));
    }
    return objectKey;
  }

  private objectExists(objectKey: string): boolean {
    try {
      return fs.statSync(this.resolveObjectPath(objectKey)).isFile();
    } catch {
      return false;
    }
  }

  private resolveObjectPath(objectKey: string): string {
    if (!/^objects\/[a-f0-9]{2}\/[a-f0-9]{64}$/.test(objectKey)) {
      throw new EmailAttachmentError(
        "attachment_content_unavailable",
        false,
        "Email attachment content is not available.",
      );
    }
    const resolved = path.resolve(path.dirname(this.objectsDir), objectKey);
    const root = `${path.resolve(path.dirname(this.objectsDir))}${path.sep}`;
    if (!resolved.startsWith(root)) {
      throw new EmailAttachmentError(
        "attachment_content_unavailable",
        false,
        "Email attachment content is not available.",
      );
    }
    return resolved;
  }
}

function attachmentRefParts(attachmentRef: string): { itemId: string } | null {
  const match = /^att_v1\.([A-Za-z0-9_-]+)\.[A-Za-z0-9_-]{22}$/.exec(attachmentRef);
  return match ? { itemId: match[1] } : null;
}

function unknownAttachment(attachmentRef: string): Error {
  return new Error(`unknown inbox attachment: ${attachmentRef}`);
}

function attachmentFailure(error: unknown): EmailAttachmentError {
  if (error instanceof EmailAttachmentError) {
    return error;
  }
  const data = isRecord(error) && isRecord(error.data) ? error.data : {};
  const code = optionalString(data.code);
  if (code) {
    return new EmailAttachmentError(code, false, "Email attachment retrieval failed.");
  }
  return new EmailAttachmentError(
    "attachment_provider_unavailable",
    false,
    "Email attachment retrieval is temporarily unavailable.",
  );
}

function assertContentTypeAllowed(
  contentType: string | null,
  policy: ReturnType<typeof parseEmailAttachmentPolicy>,
  phase: "declared" | "detected",
): void {
  if (!contentType) {
    return;
  }
  const normalized = contentType.split(";", 1)[0]!.trim().toLowerCase();
  if (policy.denyContentTypes.some((pattern) => contentTypeMatches(normalized, pattern))) {
    throw new EmailAttachmentError(
      `attachment_${phase}_content_type_denied`,
      true,
      "The attachment content type is denied by source policy.",
    );
  }
  if (
    policy.allowContentTypes.length > 0
    && !policy.allowContentTypes.some((pattern) => contentTypeMatches(normalized, pattern))
  ) {
    throw new EmailAttachmentError(
      `attachment_${phase}_content_type_not_allowed`,
      true,
      "The attachment content type is not allowed by source policy.",
    );
  }
}

function contentTypeMatches(contentType: string, pattern: string): boolean {
  return pattern.endsWith("/*")
    ? contentType.startsWith(pattern.slice(0, -1))
    : contentType === pattern;
}

async function hashFile(filePath: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  const stream = fs.createReadStream(filePath);
  for await (const chunk of stream) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

function syncFile(filePath: string): void {
  const fd = fs.openSync(filePath, "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function syncDirectory(directoryPath: string): void {
  const fd = fs.openSync(directoryPath, "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function detectContentType(filePath: string): string {
  const fd = fs.openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(512);
    const bytes = fs.readSync(fd, buffer, 0, buffer.length, 0);
    const header = buffer.subarray(0, bytes);
    if (header.subarray(0, 5).toString("ascii") === "%PDF-") {
      return "application/pdf";
    }
    if (header.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
      return "image/png";
    }
    if (header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) {
      return "image/jpeg";
    }
    const gif = header.subarray(0, 6).toString("ascii");
    if (gif === "GIF87a" || gif === "GIF89a") {
      return "image/gif";
    }
    if (header[0] === 0x50 && header[1] === 0x4b && header[2] === 0x03 && header[3] === 0x04) {
      return "application/zip";
    }
    if (header.length > 0 && !header.includes(0) && Buffer.from(header.toString("utf8"), "utf8").equals(header)) {
      return "text/plain";
    }
    return "application/octet-stream";
  } finally {
    fs.closeSync(fd);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function optionalInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
}
