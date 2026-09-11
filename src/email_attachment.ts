import crypto from "node:crypto";
import type {
  EmailAttachmentMaterialization,
  EmailAttachmentStatus,
  InboxItem,
  PublicEmailAttachment,
  PublicEmailAttachmentCollection,
} from "./model";

const ATTACHMENT_REF_PREFIX = "att_v1";
const ATTACHMENT_SELECTOR_LENGTH = 22;
const ATTACHMENT_REF_PATTERN = new RegExp(
  `^${ATTACHMENT_REF_PREFIX}\\.([A-Za-z0-9_-]+)\\.([A-Za-z0-9_-]{${ATTACHMENT_SELECTOR_LENGTH}})$`,
);

export type EmailAttachmentMaterializationLookup = (
  itemId: string,
  attachmentSelector: string,
) => EmailAttachmentMaterialization | null;

export interface ResolvedEmailAttachment {
  attachmentSelector: string;
  attachment: PublicEmailAttachment;
  handle: Record<string, unknown> | null;
}

export function publicEmailAttachmentCollection(
  itemId: string,
  metadata: Record<string, unknown> | undefined,
  materializationLookup?: EmailAttachmentMaterializationLookup,
): PublicEmailAttachmentCollection {
  const rawAttachments = Array.isArray(metadata?.attachments)
    ? metadata.attachments.filter(isRecord)
    : [];
  const attachmentCount = optionalInteger(metadata?.attachmentCount ?? metadata?.attachment_count);
  const hasAttachments = rawAttachments.length > 0
    || (attachmentCount !== null && attachmentCount > 0)
    || metadata?.hasAttachments === true
    || metadata?.has_attachments === true;
  const explicitCompleteness = optionalBoolean(
    metadata?.attachmentsComplete ?? metadata?.attachments_complete,
  );
  const attachmentsComplete = explicitCompleteness
    ?? (attachmentCount !== null
      ? attachmentCount === rawAttachments.length
      : (metadata?.hasAttachments === false || metadata?.has_attachments === false)
        && rawAttachments.length === 0);

  return {
    hasAttachments,
    attachmentCount,
    attachmentsComplete,
    attachments: rawAttachments.map((attachment, ordinal) => {
      const selector = selectorForPublicAttachment(itemId, attachment, ordinal);
      return publicEmailAttachment(
        itemId,
        attachment,
        ordinal,
        materializationLookup?.(itemId, selector) ?? null,
      );
    }),
  };
}

export function findPublicEmailAttachment(
  item: Pick<InboxItem, "itemId" | "metadata">,
  attachmentRef: string,
): PublicEmailAttachment | null {
  return resolveEmailAttachment(item, attachmentRef)?.attachment ?? null;
}

export function resolveEmailAttachment(
  item: Pick<InboxItem, "itemId" | "metadata">,
  attachmentRef: string,
  materializationLookup?: EmailAttachmentMaterializationLookup,
): ResolvedEmailAttachment | null {
  const parsed = parseEmailAttachmentRef(attachmentRef);
  if (!parsed || parsed.itemId !== item.itemId) {
    return null;
  }
  const rawAttachments = Array.isArray(item.metadata?.attachments)
    ? item.metadata.attachments.filter(isRecord)
    : [];
  for (const [ordinal, rawAttachment] of rawAttachments.entries()) {
    const selector = selectorForPublicAttachment(item.itemId, rawAttachment, ordinal);
    if (selector !== parsed.selector) {
      continue;
    }
    return {
      attachmentSelector: selector,
      attachment: publicEmailAttachment(
        item.itemId,
        rawAttachment,
        ordinal,
        materializationLookup?.(item.itemId, selector) ?? null,
      ),
      handle: isEmailAttachmentHandle(rawAttachment.handle) ? rawAttachment.handle : null,
    };
  }
  return null;
}

export function parseEmailAttachmentRef(
  attachmentRef: string,
): { itemId: string; selector: string } | null {
  const match = ATTACHMENT_REF_PATTERN.exec(attachmentRef);
  return match ? { itemId: match[1], selector: match[2] } : null;
}

export function projectPublicInboxEntry<T>(
  value: T,
  materializationLookup?: EmailAttachmentMaterializationLookup,
): T {
  if (!isRecord(value)) {
    return redactInternalEmailRefs(value);
  }
  const eventVariant = optionalString(value.eventVariant);
  const itemId = optionalString(value.itemId);
  const projected = redactInternalEmailRefs(value) as Record<string, unknown>;
  if (eventVariant !== "email.message.received" || !itemId) {
    return projected as T;
  }

  projected.metadata = projectEmailMetadata(
    itemId,
    isRecord(value.metadata) ? value.metadata : {},
    materializationLookup,
  );
  projected.rawPayload = projectEmailRawPayload(
    itemId,
    isRecord(value.rawPayload) ? value.rawPayload : {},
    materializationLookup,
  );
  delete projected.providerRawPayload;

  if (isRecord(value.item) && isRecord(projected.item)) {
    projected.item.metadata = projectEmailMetadata(
      itemId,
      isRecord(value.item.metadata) ? value.item.metadata : {},
      materializationLookup,
    );
    projected.item.rawPayload = projectEmailRawPayload(
      itemId,
      isRecord(value.item.rawPayload) ? value.item.rawPayload : {},
      materializationLookup,
    );
    delete projected.item.providerRawPayload;
  }
  return projected as T;
}

export function redactInternalEmailRefs<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map(redactInternalEmailRefs) as T;
  }
  if (!isRecord(value)) {
    return value;
  }
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === "message_ref" || key === "messageRef") {
      continue;
    }
    if (key === "handle" && isEmailAttachmentHandle(child)) {
      continue;
    }
    result[key] = redactInternalEmailRefs(child);
  }
  return result as T;
}

function projectEmailMetadata(
  itemId: string,
  metadata: Record<string, unknown>,
  materializationLookup?: EmailAttachmentMaterializationLookup,
): Record<string, unknown> {
  return {
    ...redactInternalEmailRefs(metadata),
    ...publicEmailAttachmentCollection(itemId, metadata, materializationLookup),
  };
}

function projectEmailRawPayload(
  itemId: string,
  payload: Record<string, unknown>,
  materializationLookup?: EmailAttachmentMaterializationLookup,
): Record<string, unknown> {
  const projected = redactInternalEmailRefs(payload);
  if (!isRecord(payload.message) || !isRecord(projected.message)) {
    return projected;
  }
  const collection = publicEmailAttachmentCollection(itemId, {
    attachments: payload.message.attachments,
    has_attachments: payload.message.has_attachments,
    attachment_count: payload.message.attachment_count,
    attachments_complete: payload.message.attachments_complete,
  }, materializationLookup);
  projected.message.attachments = collection.attachments;
  projected.message.attachments_complete = collection.attachmentsComplete;
  return projected;
}

function publicEmailAttachment(
  itemId: string,
  attachment: Record<string, unknown>,
  ordinal: number,
  materialization: EmailAttachmentMaterialization | null,
): PublicEmailAttachment {
  const attachmentSelector = selectorForPublicAttachment(itemId, attachment, ordinal);
  const handleRetrievable = isEmailAttachmentHandle(attachment.handle);
  const status = materialization?.status
    ?? emailAttachmentStatus(attachment.status)
    ?? (handleRetrievable ? "remote_only" : "metadata_only");
  return {
    attachmentRef: `${ATTACHMENT_REF_PREFIX}.${itemId}.${attachmentSelector}`,
    filename: optionalString(attachment.filename),
    contentType: optionalString(attachment.content_type) ?? optionalString(attachment.contentType),
    detectedContentType: materialization?.detectedContentType
      ?? optionalString(attachment.detectedContentType)
      ?? optionalString(attachment.detected_content_type),
    size: optionalInteger(attachment.size),
    disposition: attachment.disposition === "attachment" || attachment.disposition === "inline"
      ? attachment.disposition
      : null,
    contentId: optionalString(attachment.content_id) ?? optionalString(attachment.contentId),
    status,
    retrievable: handleRetrievable || status === "available",
  };
}

function selectorForPublicAttachment(
  itemId: string,
  attachment: Record<string, unknown>,
  ordinal: number,
): string {
  const existingRef = optionalString(attachment.attachmentRef);
  const parsed = existingRef ? parseEmailAttachmentRef(existingRef) : null;
  return parsed?.itemId === itemId ? parsed.selector : attachmentSelector(attachment, ordinal);
}

function attachmentSelector(attachment: Record<string, unknown>, ordinal: number): string {
  const stableId = optionalString(attachment.id);
  const identity = stableId
    ? { id: stableId }
    : {
        ordinal,
        filename: optionalString(attachment.filename),
        contentType: optionalString(attachment.content_type) ?? optionalString(attachment.contentType),
        size: optionalInteger(attachment.size),
        disposition: optionalString(attachment.disposition),
        contentId: optionalString(attachment.content_id) ?? optionalString(attachment.contentId),
      };
  return crypto.createHash("sha256")
    .update(JSON.stringify(identity))
    .digest("base64url")
    .slice(0, ATTACHMENT_SELECTOR_LENGTH);
}

function isEmailAttachmentHandle(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && value.type === "email_attachment";
}

function emailAttachmentStatus(value: unknown): EmailAttachmentStatus | null {
  return value === "metadata_only"
    || value === "remote_only"
    || value === "pending"
    || value === "available"
    || value === "quarantined"
    || value === "rejected"
    || value === "failed"
    || value === "deleted"
    ? value
    : null;
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

function optionalBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}
