import crypto from "node:crypto";

const CANONICAL_ID_ALPHABET = "23456789abcdefghjkmnpqrstvwxyz";
const CANONICAL_ID_TOKEN_LENGTH = 12;

export function nowIso(): string {
  return new Date().toISOString();
}

export function generateCanonicalId(prefix: string, length = CANONICAL_ID_TOKEN_LENGTH): string {
  return `${prefix}_${generateShortToken(length)}`;
}

export function generateId(prefix: string): string {
  return generateCanonicalId(prefix);
}

export function generateShortToken(length = CANONICAL_ID_TOKEN_LENGTH): string {
  let token = "";
  while (token.length < length) {
    const bytes = crypto.randomBytes(length - token.length);
    for (const byte of bytes) {
      token += CANONICAL_ID_ALPHABET[byte % CANONICAL_ID_ALPHABET.length];
      if (token.length >= length) {
        break;
      }
    }
  }
  return token;
}

export function parseJsonArg(
  raw?: string,
  source = "JSON argument",
  options?: {
    requireNonEmptyObject?: boolean;
  },
): Record<string, unknown> {
  if (!raw) {
    if (options?.requireNonEmptyObject) {
      throw new Error(`invalid ${source}: expected a non-empty JSON object`);
    }
    return {};
  }
  if (options?.requireNonEmptyObject && raw.trim() === "") {
    throw new Error(`invalid ${source}: expected a non-empty JSON object`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`invalid ${source}: ${message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`expected ${source} to be a JSON object`);
  }
  if (options?.requireNonEmptyObject && Object.keys(parsed as Record<string, unknown>).length === 0) {
    throw new Error(`invalid ${source}: expected a non-empty JSON object`);
  }
  return parsed as Record<string, unknown>;
}

export function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

export function jsonResponse(data: unknown): string {
  return JSON.stringify(data, null, 2);
}

export function formatEntryRef(entryId: string): string {
  return parseEntryRef(entryId);
}

export function parseEntryRef(ref: string): string {
  const value = ref.trim();
  if (!/^ent_[23456789abcdefghjkmnpqrstvwxyz]+$/.test(value)) {
    throw new Error(`invalid inbox entry id: ${ref}`);
  }
  return value;
}

export function formatThreadRef(threadId: string): string {
  return parseThreadRef(threadId);
}

export function parseThreadRef(ref: string): string {
  const value = ref.trim();
  if (!/^thr_[23456789abcdefghjkmnpqrstvwxyz]+$/.test(value)) {
    throw new Error(`invalid digest thread id: ${ref}`);
  }
  return value;
}
