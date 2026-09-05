import crypto from "node:crypto";

const CANONICAL_ID_ALPHABET = "23456789abcdefghjkmnpqrstvwxyz";
const CANONICAL_ID_TOKEN_LENGTH = 12;
const ENTRY_THREAD_ID_PATTERN = new RegExp(
  `^(ent|thr)_[${CANONICAL_ID_ALPHABET}]{${CANONICAL_ID_TOKEN_LENGTH}}$`,
);

export function nowIso(): string {
  return new Date().toISOString();
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Treats an env flag as disabled only when it holds an explicit falsy word.
 * Missing or empty values mean "unset" and keep the default behavior.
 */
export function isEnvFlagDisabled(raw: string | undefined): boolean {
  if (raw == null) {
    return false;
  }
  const normalized = raw.trim().toLowerCase();
  return normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off";
}

/**
 * Treats an env flag as set only when it holds a non-empty, non-falsy value.
 */
export function isEnvFlagEnabled(raw: string | undefined): boolean {
  return raw != null && raw.trim() !== "" && !isEnvFlagDisabled(raw);
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
  if (!ENTRY_THREAD_ID_PATTERN.test(value) || !value.startsWith("ent_")) {
    throw new Error(`invalid inbox entry id: ${ref}`);
  }
  return value;
}

export function formatThreadRef(threadId: string): string {
  return parseThreadRef(threadId);
}

export function parseThreadRef(ref: string): string {
  const value = ref.trim();
  if (!ENTRY_THREAD_ID_PATTERN.test(value) || !value.startsWith("thr_")) {
    throw new Error(`invalid digest thread id: ${ref}`);
  }
  return value;
}
