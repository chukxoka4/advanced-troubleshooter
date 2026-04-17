import { ValidationError } from "../shared/errors/index.js";

/**
 * Secret-scan for tenant JSON. Runs before env-var resolution so a raw
 * token that happens to sit next to a legitimate placeholder is still
 * rejected. The scan intentionally errs on the side of false positives —
 * tenant JSON should only contain placeholders and metadata, never a value
 * that begins with ghp_/github_pat_/sk-/etc.
 */

const ENV_REF_PATTERN = /^\$\{[A-Z_][A-Z0-9_]*\}$/;

const RAW_SECRET_PATTERNS: ReadonlyArray<{ label: string; regex: RegExp }> = [
  { label: "GitHub classic PAT (ghp_)", regex: /\bghp_[A-Za-z0-9]{10,}/ },
  { label: "GitHub OAuth (gho_)", regex: /\bgho_[A-Za-z0-9]{10,}/ },
  { label: "GitHub user-to-server (ghu_)", regex: /\bghu_[A-Za-z0-9]{10,}/ },
  { label: "GitHub server-to-server (ghs_)", regex: /\bghs_[A-Za-z0-9]{10,}/ },
  { label: "GitHub refresh (ghr_)", regex: /\bghr_[A-Za-z0-9]{10,}/ },
  { label: "GitHub fine-grained PAT (github_pat_)", regex: /\bgithub_pat_[A-Za-z0-9_]{20,}/ },
  { label: "Anthropic (sk-ant-)", regex: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { label: "OpenAI (sk-)", regex: /\bsk-[A-Za-z0-9]{20,}/ },
  { label: "Google API (AIza)", regex: /\bAIza[A-Za-z0-9_-]{20,}/ },
];

export function scanForRawSecrets(fileName: string, value: unknown, path: string[] = []): void {
  if (typeof value === "string") {
    if (ENV_REF_PATTERN.test(value)) return;
    for (const { label, regex } of RAW_SECRET_PATTERNS) {
      if (regex.test(value)) {
        const where = path.length === 0 ? "(root)" : path.join(".");
        throw new ValidationError(
          `raw secret detected in ${fileName} at ${where}: looks like a ${label}. ` +
            `Replace the value with a \${ENV_VAR} reference and move the secret into the environment.`,
        );
      }
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, idx) => scanForRawSecrets(fileName, item, [...path, `[${idx}]`]));
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      scanForRawSecrets(fileName, child, [...path, key]);
    }
  }
}
