import crypto from "node:crypto";

export function nowIso(): string {
  return new Date().toISOString();
}

export function generateId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
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

export function formatEntryRef(entryId: number): string {
  return `ent_${entryId}`;
}

export function parseEntryRef(ref: string): number {
  const match = /^ent_(\d+)$/.exec(ref.trim());
  if (!match) {
    throw new Error(`invalid inbox entry id: ${ref}`);
  }
  return Number(match[1]);
}

export function formatThreadRef(threadId: number): string {
  return `thr_${threadId}`;
}

export function parseThreadRef(ref: string): number {
  const match = /^thr_(\d+)$/.exec(ref.trim());
  if (!match) {
    throw new Error(`invalid digest thread id: ${ref}`);
  }
  return Number(match[1]);
}
