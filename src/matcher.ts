import { Interest, MatchResult } from "./model";

export function matchInterest(
  interest: Interest,
  metadata: Record<string, unknown>,
  payload: Record<string, unknown>,
): MatchResult {
  const source = { ...payload, ...metadata };
  const { matchRules } = interest;

  for (const [key, expected] of Object.entries(matchRules)) {
    const actual = source[key];
    if (Array.isArray(expected)) {
      if (!expected.includes(actual)) {
        return { matched: false, reason: `field ${key} not in allowed set` };
      }
      continue;
    }
    if (typeof expected === "string" && expected.startsWith("contains:")) {
      const needle = expected.slice("contains:".length);
      if (typeof actual !== "string" || !actual.includes(needle)) {
        return { matched: false, reason: `field ${key} missing contains:${needle}` };
      }
      continue;
    }
    if (actual !== expected) {
      return { matched: false, reason: `field ${key} mismatch` };
    }
  }

  return { matched: true, reason: "all rules matched" };
}
