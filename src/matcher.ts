import { MatchResult, Subscription } from "./model";

export function matchSubscription(
  subscription: Subscription,
  metadata: Record<string, unknown>,
  payload: Record<string, unknown>,
): MatchResult {
  const source = { ...payload, ...metadata };
  const { matchRules } = subscription;

  for (const [key, expected] of Object.entries(matchRules)) {
    const actual = source[key];
    if (Array.isArray(expected)) {
      if (Array.isArray(actual)) {
        const everyMatched = expected.every((value) => actual.includes(value));
        if (!everyMatched) {
          return { matched: false, reason: `field ${key} missing expected values` };
        }
        continue;
      }
      if (!expected.includes(actual)) {
        return { matched: false, reason: `field ${key} not in allowed set` };
      }
      continue;
    }
    if (typeof expected === "string" && expected.startsWith("contains:")) {
      const needle = expected.slice("contains:".length);
      if (Array.isArray(actual)) {
        const matched = actual.some((value) => typeof value === "string" && value.includes(needle));
        if (!matched) {
          return { matched: false, reason: `field ${key} missing contains:${needle}` };
        }
        continue;
      }
      if (typeof actual !== "string" || !actual.includes(needle)) {
        return { matched: false, reason: `field ${key} missing contains:${needle}` };
      }
      continue;
    }
    if (Array.isArray(actual)) {
      if (!actual.includes(expected)) {
        return { matched: false, reason: `field ${key} array missing value` };
      }
      continue;
    }
    if (actual !== expected) {
      return { matched: false, reason: `field ${key} mismatch` };
    }
  }

  return { matched: true, reason: "all rules matched" };
}
