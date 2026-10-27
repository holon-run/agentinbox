import fs from "node:fs";
import path from "node:path";

/**
 * Reads the package version of the AgentInbox install this module belongs to.
 *
 * The daemon process uses it to self-report its own build version over
 * healthz, while CLI processes report `cliVersion` with the same helper.
 * Keeping both sides explicit makes mixed-build environments observable
 * instead of silently inheriting whichever client called first (#269).
 */
export function readOwnPackageVersion(): string | null {
  const candidatePaths = [
    path.join(__dirname, "..", "package.json"),
    path.join(__dirname, "..", "..", "package.json"),
  ];
  for (const candidate of candidatePaths) {
    try {
      const parsed = JSON.parse(fs.readFileSync(candidate, "utf8")) as { version?: unknown };
      if (typeof parsed.version === "string" && parsed.version.length > 0) {
        return parsed.version;
      }
    } catch {
      continue;
    }
  }
  return null;
}
