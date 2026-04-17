import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ForbiddenError } from "../shared/errors/index.js";

/**
 * Auth middleware. Extracts the API key from the Authorization header and
 * verifies it via a caller-supplied verifier function. The verifier itself
 * is swappable so prototype (shared .env key) and production (hashed
 * per-tenant keys — added in commit 24) share the same middleware.
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

/**
 * Prototype verifier. Constant-time compares the presented key to a single
 * shared secret from the environment. Does not touch the database.
 */
export function sharedKeyVerifier(sharedKey: string | undefined): VerifyApiKey {
  return async (presented: string): Promise<boolean> => {
    if (!sharedKey) return false;
    const a = Buffer.from(presented, "utf8");
    const b = Buffer.from(sharedKey, "utf8");
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  };
}
