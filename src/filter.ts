import { MatchResult, SubscriptionFilter } from "./model";

const { Jexl } = require("jexl") as {
  Jexl: new () => {
    addFunction(name: string, fn: (...args: unknown[]) => unknown): unknown;
    eval(expression: string, context: Record<string, unknown>): Promise<unknown>;
  };
};

export interface FilterContext {
  metadata: Record<string, unknown>;
  payload: Record<string, unknown>;
  eventVariant: string;
  sourceType: string;
  sourceKey: string;
}

const jexl = new Jexl();
const MAX_REGEX_PATTERN_LENGTH = 256;
const MAX_REGEX_VALUE_LENGTH = 4_096;

jexl.addFunction("contains", (search: unknown, item: unknown) => {
  if (typeof search === "string") {
    return typeof item === "string" ? search.includes(item) : false;
  }
  if (Array.isArray(search)) {
    return search.some((value) => deepEqual(value, item));
  }
  return false;
});

jexl.addFunction("startsWith", (value: unknown, search: unknown) => (
  typeof value === "string" && typeof search === "string" ? value.startsWith(search) : false
));

jexl.addFunction("endsWith", (value: unknown, search: unknown) => (
  typeof value === "string" && typeof search === "string" ? value.endsWith(search) : false
));

jexl.addFunction("format", (template: unknown, ...values: unknown[]) => {
  if (typeof template !== "string") {
    return "";
  }
  return template.replace(/\{(\d+)\}/g, (_match, index) => String(values[Number(index)] ?? ""));
});

jexl.addFunction("join", (value: unknown, separator: unknown) => (
  Array.isArray(value) ? value.join(typeof separator === "string" ? separator : ",") : ""
));

jexl.addFunction("matches", (value: unknown, pattern: unknown) => {
  if (typeof value !== "string" || typeof pattern !== "string") {
    return false;
  }
  if (value.length > MAX_REGEX_VALUE_LENGTH) {
    return false;
  }
  try {
    const regex = compileSafeRegex(pattern);
    return regex ? regex.test(value) : false;
  } catch {
    return false;
  }
});

jexl.addFunction("glob", (value: unknown, pattern: unknown) => (
  typeof value === "string" && typeof pattern === "string" ? globMatch(value, pattern) : false
));

jexl.addFunction("exists", (value: unknown) => value !== undefined && value !== null);

export async function matchSubscriptionFilter(
  filter: SubscriptionFilter,
  context: FilterContext,
): Promise<MatchResult> {
  if (filter.metadata && !matchesShortcutFilter(filter.metadata, context.metadata)) {
    return { matched: false, reason: "metadata shortcut mismatch" };
  }
  if (filter.payload && !matchesShortcutFilter(filter.payload, context.payload)) {
    return { matched: false, reason: "payload shortcut mismatch" };
  }
  if (filter.expr) {
    let result: unknown;
    try {
      result = await jexl.eval(filter.expr, context as unknown as Record<string, unknown>);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { matched: false, reason: `expr evaluation failed: ${message}` };
    }
    if (!Boolean(result)) {
      return { matched: false, reason: "expr returned false" };
    }
  }
  return { matched: true, reason: filter.expr ? "filter shortcuts and expr matched" : "filter shortcuts matched" };
}

export async function validateSubscriptionFilter(filter: SubscriptionFilter): Promise<void> {
  if (!filter.expr) {
    return;
  }
  await jexl.eval(filter.expr, {
    metadata: {},
    payload: {},
    eventVariant: "",
    sourceType: "",
    sourceKey: "",
  });
}

function matchesShortcutFilter(expected: Record<string, unknown>, actual: Record<string, unknown>): boolean {
  return Object.entries(expected).every(([key, value]) => matchesExpectedValue(readPath(actual, key), value));
}

function matchesExpectedValue(actual: unknown, expected: unknown): boolean {
  if (isPlainObject(expected)) {
    if (!isPlainObject(actual)) {
      return false;
    }
    return Object.entries(expected).every(([key, value]) => matchesExpectedValue(readPath(actual, key), value));
  }
  if (Array.isArray(expected)) {
    if (Array.isArray(actual)) {
      return expected.every((expectedValue) => actual.some((actualValue) => matchesExpectedValue(actualValue, expectedValue)));
    }
    return expected.some((expectedValue) => matchesExpectedValue(actual, expectedValue));
  }
  if (Array.isArray(actual)) {
    return actual.some((actualValue) => matchesExpectedValue(actualValue, expected));
  }
  return deepEqual(actual, expected);
}

function readPath(value: unknown, path: string): unknown {
  if (!path.includes(".")) {
    if (!isPlainObject(value)) {
      return undefined;
    }
    return value[path];
  }
  return path.split(".").reduce<unknown>((current, segment) => {
    if (!isPlainObject(current)) {
      return undefined;
    }
    return current[segment];
  }, value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) => deepEqual(value, right[index]));
  }
  if (isPlainObject(left) && isPlainObject(right)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    return leftKeys.length === rightKeys.length
      && leftKeys.every((key) => deepEqual(left[key], right[key]));
  }
  return left === right;
}

function globMatch(value: string, pattern: string): boolean {
  const regex = new RegExp(`^${globToRegex(pattern)}$`);
  return regex.test(value);
}

function compileSafeRegex(pattern: string): RegExp | null {
  if (pattern.length === 0 || pattern.length > MAX_REGEX_PATTERN_LENGTH) {
    return null;
  }
  if (pattern.includes("(?") || /\\[1-9]/.test(pattern)) {
    return null;
  }
  if (hasNestedQuantifier(pattern)) {
    return null;
  }
  return new RegExp(pattern);
}

function hasNestedQuantifier(pattern: string): boolean {
  return /\((?:[^()\\]|\\.)*[+*](?:[^()\\]|\\.)*\)[+*{]/.test(pattern);
}

function globToRegex(pattern: string): string {
  let regex = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    const next = pattern[index + 1];
    if (char === "*" && next === "*") {
      regex += ".*";
      index += 1;
      continue;
    }
    if (char === "*") {
      regex += "[^/]*";
      continue;
    }
    regex += escapeRegex(char);
  }
  return regex;
}

function escapeRegex(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}
