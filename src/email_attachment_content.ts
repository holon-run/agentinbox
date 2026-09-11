import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { UxcDaemonClient } from "@holon-run/uxc-daemon-client";
import {
  publicEmailAttachmentCollection,
  resolveEmailAttachment,
} from "./email_attachment";
import type {
  EmailAttachmentAuditAction,
  EmailAttachmentAuditEvent,
  EmailAttachmentMaterialization,
  InboxItem,
  PublicEmailAttachment,
  SourceStream,
} from "./model";
import { parseEmailAttachmentPolicy } from "./sources/email";
import { AgentInboxStore } from "./store";
import { generateCanonicalId, nowIso } from "./util";

export const EMAIL_ATTACHMENT_DEFAULT_MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const EMAIL_ATTACHMENT_DEFAULT_GC_BATCH_SIZE = 256;
const EMAIL_ATTACHMENT_STAGING_MAX_AGE_MS = 60 * 60 * 1000;

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

export interface EmailAttachmentScanner {
  scan(input: {
    path: string;
    sha256: string;
    size: number;
    contentType: string;
  }): Promise<{
    status: "clean" | "quarantined" | "rejected";
    code?: string | null;
  }>;
}

export interface EmailAttachmentContentManagerOptions {
  scanner?: EmailAttachmentScanner | null;
  maxTotalBytes?: number;
  gcBatchSize?: number;
}

export interface EmailAttachmentGcResult {
  expired: number;
  capacityEvicted: number;
  objectsDeleted: number;
  orphanObjectsDeleted: number;
  stagingFilesDeleted: number;
  managedBytes: number;
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
  private readonly publishingObjects = new Map<string, number>();
  private readonly stagingDir: string;
  private readonly objectsDir: string;
  private readonly scanner: EmailAttachmentScanner | null;
  private readonly maxTotalBytes: number;
  private readonly gcBatchSize: number;

  constructor(
    private readonly store: AgentInboxStore,
    rootDir: string,
    private readonly uxc: EmailAttachmentUxcClient = new UxcDaemonClient({ env: process.env }),
    options: EmailAttachmentContentManagerOptions = {},
  ) {
    this.stagingDir = path.join(rootDir, "staging");
    this.objectsDir = path.join(rootDir, "objects");
    this.scanner = options.scanner ?? null;
    this.maxTotalBytes = positiveIntegerOrDefault(
      options.maxTotalBytes ?? process.env.AGENTINBOX_EMAIL_ATTACHMENT_MAX_TOTAL_BYTES,
      EMAIL_ATTACHMENT_DEFAULT_MAX_TOTAL_BYTES,
    );
    this.gcBatchSize = positiveIntegerOrDefault(
      options.gcBatchSize,
      EMAIL_ATTACHMENT_DEFAULT_GC_BATCH_SIZE,
    );
  }

  inspect(agentId: string, attachmentRef: string): PublicEmailAttachment {
    try {
      const owned = this.resolveOwned(agentId, attachmentRef);
      if (owned.attachment.status === "deleted") {
        throw unknownAttachment(attachmentRef);
      }
      this.appendAudit(agentId, attachmentRef, "metadata_read", "success", owned);
      return owned.attachment;
    } catch (error) {
      this.appendAudit(
        agentId,
        attachmentRef,
        "metadata_read",
        "rejected",
        null,
        auditErrorCode(error),
      );
      throw error;
    }
  }

  async materialize(agentId: string, attachmentRef: string): Promise<PublicEmailAttachment> {
    let owned: OwnedAttachment;
    try {
      owned = this.resolveOwned(agentId, attachmentRef);
      if (owned.attachment.status === "deleted") {
        throw unknownAttachment(attachmentRef);
      }
      this.appendAudit(agentId, attachmentRef, "materialize", "started", owned);
    } catch (error) {
      this.appendAudit(
        agentId,
        attachmentRef,
        "materialize",
        "rejected",
        null,
        auditErrorCode(error),
      );
      throw error;
    }
    const current = this.store.getEmailAttachmentMaterialization(
      owned.item.itemId,
      owned.attachmentSelector,
    );
    if (current?.status === "available" && current.objectKey && this.objectExists(current.objectKey)) {
      const attachment = this.resolveOwned(agentId, attachmentRef).attachment;
      this.appendAudit(
        agentId,
        attachmentRef,
        "materialize",
        "available",
        owned,
        null,
        current,
      );
      return attachment;
    }

    const key = `${owned.inboxId}:${owned.item.itemId}:${owned.attachmentSelector}`;
    const existing = this.inFlight.get(key);
    if (existing) {
      return this.auditMaterializationResult(agentId, attachmentRef, owned, existing);
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
    return this.auditMaterializationResult(agentId, attachmentRef, owned, pending);
  }

  openContent(agentId: string, attachmentRef: string): EmailAttachmentContent {
    try {
      const content = this.openContentOnce(agentId, attachmentRef);
      const owned = this.resolveOwned(agentId, attachmentRef);
      const materialization = this.store.getEmailAttachmentMaterialization(
        owned.item.itemId,
        owned.attachmentSelector,
      );
      this.appendAudit(
        agentId,
        attachmentRef,
        "content_read",
        "success",
        owned,
        null,
        materialization,
      );
      return content;
    } catch (error) {
      this.appendAudit(
        agentId,
        attachmentRef,
        "content_read",
        "rejected",
        null,
        auditErrorCode(error),
      );
      throw error;
    }
  }

  private openContentOnce(agentId: string, attachmentRef: string): EmailAttachmentContent {
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

  async delete(
    agentId: string,
    attachmentRef: string,
  ): Promise<{ attachmentRef: string; deleted: boolean }> {
    let owned: OwnedAttachment;
    try {
      owned = this.resolveOwned(agentId, attachmentRef);
    } catch (error) {
      this.appendAudit(
        agentId,
        attachmentRef,
        "delete",
        "rejected",
        null,
        auditErrorCode(error),
      );
      throw error;
    }
    const itemKey = `${owned.inboxId}:${owned.item.itemId}`;
    const previousItem = this.itemInFlight.get(itemKey) ?? Promise.resolve();
    const deletion = previousItem
      .catch(() => undefined)
      .then(() => this.deleteOnce(agentId, attachmentRef, owned));
    const itemCompletion = deletion.then(
      () => undefined,
      () => undefined,
    ).finally(() => {
      if (this.itemInFlight.get(itemKey) === itemCompletion) {
        this.itemInFlight.delete(itemKey);
      }
    });
    this.itemInFlight.set(itemKey, itemCompletion);
    return deletion;
  }

  gc(now = new Date()): EmailAttachmentGcResult {
    const objectKeys = new Set<string>();
    let expired = 0;
    let capacityEvicted = 0;
    let objectsDeleted = 0;
    const cutoffIso = now.toISOString();
    for (
      const candidate of this.store.listExpiredEmailAttachmentMaterializations(
        cutoffIso,
        this.gcBatchSize,
      )
    ) {
      const previous = this.tombstoneForGc(candidate, "attachment_retention_expired", cutoffIso);
      if (previous) {
        expired += 1;
        if (previous.objectKey) {
          objectKeys.add(previous.objectKey);
        }
      }
    }

    let managedBytes = this.store.sumManagedEmailAttachmentBytes();
    if (managedBytes > this.maxTotalBytes) {
      for (const object of this.store.listOldestEmailAttachmentObjects(this.gcBatchSize)) {
        if (managedBytes <= this.maxTotalBytes) {
          break;
        }
        const references = this.store.listEmailAttachmentMaterializationsForObject(
          object.objectKey,
        );
        let evictedObject = false;
        for (const candidate of references) {
          const previous = this.tombstoneForGc(
            candidate,
            "attachment_capacity_evicted",
            cutoffIso,
          );
          if (previous) {
            capacityEvicted += 1;
            evictedObject = true;
          }
        }
        if (evictedObject) {
          objectKeys.add(object.objectKey);
          managedBytes = Math.max(0, managedBytes - object.storedSize);
        }
      }
    }

    for (const objectKey of objectKeys) {
      if (this.deleteObjectIfUnreferenced(objectKey)) {
        objectsDeleted += 1;
      }
    }
    const orphanObjectsDeleted = this.deleteOrphanObjects(this.gcBatchSize);
    const stagingFilesDeleted = this.deleteStaleStagingFiles(
      now.getTime() - EMAIL_ATTACHMENT_STAGING_MAX_AGE_MS,
      this.gcBatchSize,
    );
    return {
      expired,
      capacityEvicted,
      objectsDeleted,
      orphanObjectsDeleted,
      stagingFilesDeleted,
      managedBytes: this.store.sumManagedEmailAttachmentBytes(),
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
      const scanResult = this.scanner
        ? await this.scanner.scan({
          path: stagingPath,
          sha256,
          size: stat.size,
          contentType: detectedContentType,
        })
        : { status: "clean" as const, code: null };
      if (scanResult.status === "rejected") {
        throw new EmailAttachmentError(
          stableAttachmentErrorCode(
            scanResult.code,
            "attachment_scanner_rejected",
          ),
          true,
          "The attachment was rejected by the configured scanner.",
        );
      }
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
      const objectKey = objectKeyForSha256(sha256);
      this.beginObjectPublication(objectKey);
      try {
        await this.putObject(stagingPath, sha256, objectKey);
        const completedAt = nowIso();
        const record: EmailAttachmentMaterialization = {
          ...pending,
          status: scanResult.status === "quarantined" ? "quarantined" : "available",
          lastErrorCode: scanResult.status === "quarantined"
            ? stableAttachmentErrorCode(
              scanResult.code,
              "attachment_scanner_quarantined",
            )
            : null,
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
      } finally {
        this.endObjectPublication(objectKey);
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

  private async auditMaterializationResult(
    agentId: string,
    attachmentRef: string,
    owned: OwnedAttachment,
    operation: Promise<PublicEmailAttachment>,
  ): Promise<PublicEmailAttachment> {
    try {
      const attachment = await operation;
      const materialization = this.store.getEmailAttachmentMaterialization(
        owned.item.itemId,
        owned.attachmentSelector,
      );
      this.appendAudit(
        agentId,
        attachmentRef,
        "materialize",
        materialization?.status ?? attachment.status,
        owned,
        materialization?.lastErrorCode ?? null,
        materialization,
      );
      return attachment;
    } catch (error) {
      const materialization = this.store.getEmailAttachmentMaterialization(
        owned.item.itemId,
        owned.attachmentSelector,
      );
      this.appendAudit(
        agentId,
        attachmentRef,
        "materialize",
        materialization?.status ?? "failed",
        owned,
        materialization?.lastErrorCode ?? auditErrorCode(error),
        materialization,
      );
      throw error;
    }
  }

  private deleteOnce(
    agentId: string,
    attachmentRef: string,
    initial: OwnedAttachment,
  ): { attachmentRef: string; deleted: boolean } {
    const owned = this.resolveOwned(agentId, attachmentRef);
    if (
      owned.item.itemId !== initial.item.itemId
      || owned.attachmentSelector !== initial.attachmentSelector
    ) {
      throw unknownAttachment(attachmentRef);
    }
    const current = this.store.getEmailAttachmentMaterialization(
      owned.item.itemId,
      owned.attachmentSelector,
    );
    if (current?.status === "deleted") {
      this.appendAudit(agentId, attachmentRef, "delete", "already_deleted", owned);
      return { attachmentRef, deleted: false };
    }
    const deletedAt = nowIso();
    const tombstoneFallback: EmailAttachmentMaterialization = {
      itemId: owned.item.itemId,
      attachmentSelector: owned.attachmentSelector,
      status: "deleted",
      lastErrorCode: "attachment_explicitly_deleted",
      objectKey: null,
      sha256: null,
      declaredContentType: owned.attachment.contentType,
      detectedContentType: owned.attachment.detectedContentType,
      declaredSize: owned.attachment.size,
      storedSize: null,
      createdAt: deletedAt,
      updatedAt: deletedAt,
      expiresAt: null,
      deletedAt,
    };
    const previous = this.store.tombstoneEmailAttachmentMaterialization(
      owned.inboxId,
      owned.item.itemId,
      owned.attachmentSelector,
      deletedAt,
      this.auditEvent(
        agentId,
        attachmentRef,
        "delete",
        "deleted",
        owned,
        "attachment_explicitly_deleted",
        current,
      ),
      tombstoneFallback,
    );
    if (!previous) {
      throw unknownAttachment(attachmentRef);
    }
    if (previous.objectKey) {
      this.deleteObjectIfUnreferenced(previous.objectKey);
    }
    return { attachmentRef, deleted: true };
  }

  private tombstoneForGc(
    candidate: {
      materialization: EmailAttachmentMaterialization;
      inboxId: string;
      agentId: string;
      sourceId: string;
    },
    errorCode: string,
    deletedAt: string,
  ): EmailAttachmentMaterialization | null {
    const materialization = candidate.materialization;
    const attachmentRef = `att_v1.${materialization.itemId}.${materialization.attachmentSelector}`;
    return this.store.tombstoneEmailAttachmentMaterialization(
      candidate.inboxId,
      materialization.itemId,
      materialization.attachmentSelector,
      deletedAt,
      {
        auditId: generateCanonicalId("aat"),
        attachmentRef,
        claimedAgentId: candidate.agentId,
        inboxId: candidate.inboxId,
        itemId: materialization.itemId,
        sourceId: candidate.sourceId,
        action: "gc",
        result: "deleted",
        errorCode,
        bytes: materialization.storedSize,
        sha256: materialization.sha256,
        createdAt: deletedAt,
      },
    );
  }

  private appendAudit(
    agentId: string,
    attachmentRef: string,
    action: EmailAttachmentAuditAction,
    result: string,
    owned: OwnedAttachment | null,
    errorCode: string | null = null,
    materialization: EmailAttachmentMaterialization | null = null,
  ): void {
    this.store.appendEmailAttachmentAudit(
      this.auditEvent(
        agentId,
        attachmentRef,
        action,
        result,
        owned,
        errorCode,
        materialization,
      ),
    );
  }

  private auditEvent(
    agentId: string,
    attachmentRef: string,
    action: EmailAttachmentAuditAction,
    result: string,
    owned: OwnedAttachment | null,
    errorCode: string | null = null,
    materialization: EmailAttachmentMaterialization | null = null,
  ): EmailAttachmentAuditEvent {
    return {
      auditId: generateCanonicalId("aat"),
      attachmentRef: safeAuditAttachmentRef(attachmentRef),
      claimedAgentId: agentId,
      inboxId: owned?.inboxId ?? null,
      itemId: owned?.item.itemId ?? null,
      sourceId: owned?.source.sourceId ?? null,
      action,
      result,
      errorCode: errorCode
        ? stableAttachmentErrorCode(errorCode, "attachment_operation_failed")
        : null,
      bytes: materialization?.storedSize ?? null,
      sha256: materialization?.sha256 ?? null,
      createdAt: nowIso(),
    };
  }

  private deleteObjectIfUnreferenced(objectKey: string): boolean {
    if (this.publishingObjects.has(objectKey)) {
      return false;
    }
    if (this.store.countEmailAttachmentObjectReferences(objectKey) > 0) {
      return false;
    }
    try {
      const objectPath = this.resolveObjectPath(objectKey);
      fs.rmSync(objectPath, { force: true });
      try {
        fs.rmdirSync(path.dirname(objectPath));
      } catch {
        // A shared hash prefix may still contain other managed objects.
      }
      return true;
    } catch {
      return false;
    }
  }

  private deleteOrphanObjects(limit: number): number {
    const referenced = new Set(this.store.listReferencedEmailAttachmentObjectKeys());
    let deleted = 0;
    let prefixes: fs.Dirent[];
    try {
      prefixes = fs.readdirSync(this.objectsDir, { withFileTypes: true });
    } catch {
      return 0;
    }
    for (const prefix of prefixes) {
      if (deleted >= limit || !prefix.isDirectory() || !/^[a-f0-9]{2}$/.test(prefix.name)) {
        continue;
      }
      const prefixPath = path.join(this.objectsDir, prefix.name);
      let objects: fs.Dirent[];
      try {
        objects = fs.readdirSync(prefixPath, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const object of objects) {
        if (deleted >= limit) {
          break;
        }
        const objectKey = path.posix.join("objects", prefix.name, object.name);
        if (
          object.isFile()
          && /^[a-f0-9]{64}$/.test(object.name)
          && !referenced.has(objectKey)
          && this.deleteObjectIfUnreferenced(objectKey)
        ) {
          deleted += 1;
        }
      }
    }
    return deleted;
  }

  private deleteStaleStagingFiles(olderThanMs: number, limit: number): number {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(this.stagingDir, { withFileTypes: true });
    } catch {
      return 0;
    }
    let deleted = 0;
    for (const entry of entries) {
      if (deleted >= limit || !entry.isFile() || !/^[a-f0-9]{36}$/.test(entry.name)) {
        continue;
      }
      const stagingPath = path.join(this.stagingDir, entry.name);
      try {
        if (fs.statSync(stagingPath).mtimeMs <= olderThanMs) {
          fs.rmSync(stagingPath, { force: true });
          deleted += 1;
        }
      } catch {
        // A concurrent materialization may already have published or removed it.
      }
    }
    return deleted;
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

  private async putObject(
    stagingPath: string,
    sha256: string,
    objectKey: string,
  ): Promise<void> {
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
  }

  private beginObjectPublication(objectKey: string): void {
    this.publishingObjects.set(
      objectKey,
      (this.publishingObjects.get(objectKey) ?? 0) + 1,
    );
  }

  private endObjectPublication(objectKey: string): void {
    const count = this.publishingObjects.get(objectKey) ?? 0;
    if (count <= 1) {
      this.publishingObjects.delete(objectKey);
      return;
    }
    this.publishingObjects.set(objectKey, count - 1);
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

function objectKeyForSha256(sha256: string): string {
  return path.posix.join("objects", sha256.slice(0, 2), sha256);
}

function unknownAttachment(attachmentRef: string): Error {
  return new Error(`unknown inbox attachment: ${attachmentRef}`);
}

function attachmentFailure(error: unknown): EmailAttachmentError {
  if (error instanceof EmailAttachmentError) {
    return error;
  }
  const data = isRecord(error) && isRecord(error.data) ? error.data : {};
  const code = stableAttachmentErrorCode(data.code, "");
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

function safeAuditAttachmentRef(attachmentRef: string): string {
  return /^att_v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{22}$/.test(attachmentRef)
    ? attachmentRef
    : "invalid_attachment_ref";
}

function stableAttachmentErrorCode(value: unknown, fallback: string): string {
  return typeof value === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(value)
    ? value
    : fallback;
}

function auditErrorCode(error: unknown): string {
  if (error instanceof EmailAttachmentError) {
    return error.code;
  }
  if (error instanceof Error && error.message.startsWith("unknown inbox attachment:")) {
    return "attachment_not_found";
  }
  return "attachment_operation_failed";
}

function positiveIntegerOrDefault(value: unknown, fallback: number): number {
  const parsed = typeof value === "string" && value.trim().length > 0
    ? Number(value)
    : value;
  return Number.isSafeInteger(parsed) && Number(parsed) > 0
    ? Number(parsed)
    : fallback;
}
