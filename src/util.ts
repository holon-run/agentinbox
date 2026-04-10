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
    requireNonEmpty?: boolean;
  },
): Record<string, unknown> {
  if (!raw) {
    if (options?.requireNonEmpty) {
      throw new Error(`invalid ${source}: expected a non-empty JSON object`);
    }
    return {};
  }
  if (options?.requireNonEmpty && raw.trim() === "") {
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
