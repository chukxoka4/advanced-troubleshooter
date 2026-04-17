import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Build identity surfaced by /health and the logger at boot. Version is
 * read from the server package.json (authoritative source); gitSha is
 * pulled from Railway's RAILWAY_GIT_COMMIT_SHA in production and from an
 * optional GIT_SHA override locally. Missing SHA is a supported state —
 * /health returns null rather than failing.
 */

export interface BuildInfo {
  version: string;
  gitSha: string | null;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_JSON_PATH = resolve(HERE, "../../package.json");

function readGitSha(): string | null {
  return (
    process.env.RAILWAY_GIT_COMMIT_SHA ??
    process.env.GIT_SHA ??
    null
  );
}

export async function loadBuildInfo(): Promise<BuildInfo> {
  const raw = await readFile(PACKAGE_JSON_PATH, "utf8");
  const parsed = JSON.parse(raw) as { version?: unknown };
  if (typeof parsed.version !== "string" || parsed.version.length === 0) {
    throw new Error("package.json is missing a string version");
  }
  return { version: parsed.version, gitSha: readGitSha() };
}
