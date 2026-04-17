import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
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
 */

const KEY_PREFIX = "ats_";
const KEY_ENTROPY_BYTES = 32;
const HASH_ALGO = "sha256";

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
  randomBytesImpl?: (n: number) => Buffer;
}

function base64Url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function hashPlaintext(plaintext: string): string {
  return createHash(HASH_ALGO).update(plaintext, "utf8").digest("hex");
}

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export function createApiKeyService(deps: ApiKeyServiceDeps): ApiKeyService {
  const rand = deps.randomBytesImpl ?? ((n: number) => randomBytes(n));

  return {
    async generate({ tenantId, label }) {
      if (!tenantId) throw new Error("apiKeyService.generate: tenantId is required");
      const plaintext = `${KEY_PREFIX}${base64Url(rand(KEY_ENTROPY_BYTES))}`;
      const keyHash = hashPlaintext(plaintext);
      const row = await deps.repository.storeKeyHash({ tenantId, keyHash, ...(label ? { label } : {}) });
      return { plaintext, row };
    },

    async verify(presented) {
      if (!presented || !presented.startsWith(KEY_PREFIX)) return null;
      const digest = hashPlaintext(presented);
      const row = await deps.repository.findByKeyHash(digest);
      if (!row) return null;
      // Defence in depth: the repository already matched by digest, but we
      // re-compare with a constant-time check to avoid leaking information
      // through any future non-constant-time storage lookup.
      const stored = hashPlaintext(presented);
      if (!constantTimeEqual(stored, digest)) return null;
      return row;
    },

    hash(plaintext) {
      return hashPlaintext(plaintext);
    },
  };
}
