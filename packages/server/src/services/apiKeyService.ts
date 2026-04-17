import { createHmac, randomBytes } from "node:crypto";
import type { ApiKeyRepository, ApiKeyRow } from "../repositories/apiKey.repository.js";

/**
 * apiKeyService — mints and verifies tenant API keys.
 *
 *   generate(tenantId, label?) → { plaintext, row }
 *     Plaintext is returned once and never again. Only the SHA-256 digest is
 *     persisted. The plaintext carries an "ats_" prefix so operators can
 *     recognise it in a support ticket without leaking any secret-looking
 *     shape (ghp_, sk-, etc.) that our own secret-scanner would reject.
 *
 *   verify(presented) → ApiKeyRow | null
 *     Constant-time comparison at the digest level. A presented key that
 *     does not parse, hashes to a missing row, or points at a revoked row
 *     returns null — the caller (auth middleware) maps that to 403.
 *
 * The service never logs plaintext and never returns plaintext from any
 * method other than generate(). Callers must treat the plaintext as
 * write-once and forward it to the operator exactly once.
 *
 * Stored form is HMAC-SHA256(pepper, plaintext). The pepper is a
 * process-held secret (API_KEY_PEPPER env var) that is NOT in the
 * database; an attacker who dumps the api_keys table still cannot brute
 * force plaintexts without also compromising the application environment.
 * A password-hashing KDF (argon2id/scrypt) would add a work factor on top
 * of that, at the cost of a new dependency and a per-request CPU hit; the
 * 256-bit entropy in each plaintext makes the work factor less critical
 * than the pepper does. If that trade-off changes, swap `createHmac`
 * here for a KDF and re-mint keys — the repository column is unchanged.
 */

const KEY_PREFIX = "ats_";
const KEY_ENTROPY_BYTES = 32;

export interface GenerateApiKeyInput {
  tenantId: string;
  label?: string;
}

export interface GenerateApiKeyResult {
  plaintext: string;
  row: ApiKeyRow;
}

export interface ApiKeyService {
  generate(input: GenerateApiKeyInput): Promise<GenerateApiKeyResult>;
  verify(presented: string): Promise<ApiKeyRow | null>;
  hash(plaintext: string): string;
}

export interface ApiKeyServiceDeps {
  repository: ApiKeyRepository;
  /**
   * Process-held pepper (NOT persisted). In production this comes from
   * API_KEY_PEPPER. Tests pass an explicit value. A missing pepper in
   * production throws at boot rather than silently falling back to an
   * unpeppered hash.
   */
  pepper: string;
  randomBytesImpl?: (n: number) => Buffer;
}

function base64Url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function pepperedHash(pepper: string, plaintext: string): string {
  return createHmac("sha256", pepper).update(plaintext, "utf8").digest("hex");
}

export function createApiKeyService(deps: ApiKeyServiceDeps): ApiKeyService {
  if (!deps.pepper || deps.pepper.length < 32) {
    throw new Error(
      "apiKeyService: pepper must be at least 32 characters (set API_KEY_PEPPER)",
    );
  }
  const rand = deps.randomBytesImpl ?? ((n: number) => randomBytes(n));
  const hash = (plaintext: string): string => pepperedHash(deps.pepper, plaintext);

  return {
    async generate({ tenantId, label }) {
      if (!tenantId) throw new Error("apiKeyService.generate: tenantId is required");
      const plaintext = `${KEY_PREFIX}${base64Url(rand(KEY_ENTROPY_BYTES))}`;
      const keyHash = hash(plaintext);
      const row = await deps.repository.storeKeyHash({ tenantId, keyHash, ...(label ? { label } : {}) });
      return { plaintext, row };
    },

    async verify(presented) {
      if (!presented || !presented.startsWith(KEY_PREFIX)) return null;
      const digest = hash(presented);
      const row = await deps.repository.findByKeyHash(digest);
      return row ?? null;
    },

    hash,
  };
}
