import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ForbiddenError } from "../shared/errors/index.js";

/**
 * Auth middleware. Extracts the API key from the Authorization header and
 * verifies it via a caller-supplied verifier function. The verifier itself
 * is swappable so prototype (shared .env key) and production (hashed
 * per-tenant keys — added in commit 24) share the same middleware.
 *
 * PROTOTYPE-MODE CAVEAT (tracked in architecture-plan §"Auth & tenant
 * isolation"): when APP_MODE=prototype, a valid SHARED_API_KEY does not
 * identify a tenant — any authenticated client can set X-Tenant-Id to
 * any configured tenantId and tenant scope simply follows header choice.
 * Prototype deployments must therefore be treated as a single trust zone
 * (one team, one shared key). Commit 24 replaces this with per-tenant
 * hashed keys stored in the api_keys table, at which point the key
 * itself determines the tenant and spoofing by header becomes impossible.
 */

const BEARER_PREFIX = /^Bearer\s+/i;

export type VerifyApiKey = (presentedKey: string) => Promise<boolean>;

export interface AuthOptions {
  verifyApiKey: VerifyApiKey;
}

function extractBearer(authorizationHeader: string | undefined): string | undefined {
  if (!authorizationHeader) return undefined;
  if (!BEARER_PREFIX.test(authorizationHeader)) return undefined;
  return authorizationHeader.replace(BEARER_PREFIX, "").trim() || undefined;
}

export async function registerAuth(
  app: FastifyInstance,
  options: AuthOptions,
): Promise<void> {
  app.addHook("onRequest", async (req: FastifyRequest, _reply: FastifyReply) => {
    const presented = extractBearer(req.headers.authorization);
    if (!presented) {
      throw new ForbiddenError("missing bearer token");
    }
    const ok = await options.verifyApiKey(presented);
    if (!ok) throw new ForbiddenError("invalid api key");
  });
}

function sha256(input: string): Buffer {
  return createHash("sha256").update(input, "utf8").digest();
}

/**
 * Prototype verifier. SHA-256s both the presented and the configured key
 * to a fixed 32-byte digest, then compares with timingSafeEqual. Hashing
 * to a constant width eliminates the length-dependent timing side channel
 * that a naïve length-check + timingSafeEqual exposes (an attacker can
 * probe key length by measuring response time on mismatched inputs).
 */
export function sharedKeyVerifier(sharedKey: string | undefined): VerifyApiKey {
  const expectedDigest = sharedKey ? sha256(sharedKey) : null;
  return async (presented: string): Promise<boolean> => {
    if (!expectedDigest) return false;
    const presentedDigest = sha256(presented);
    return timingSafeEqual(presentedDigest, expectedDigest);
  };
}
