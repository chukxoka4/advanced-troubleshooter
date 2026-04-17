import fastifyCors from "@fastify/cors";
import type { FastifyInstance } from "fastify";

/**
 * CORS middleware.
 *
 * allowedOrigins === null  → permissive (prototype): every origin is
 *                            reflected. Suitable for local development
 *                            against ad-hoc URLs.
 * allowedOrigins !== null  → strict: origin must appear in the set. The
 *                            set is typically the union of every tenant's
 *                            allowedOrigins, built in register.ts at boot.
 *
 * Per-tenant enforcement of allowedOrigins happens again once the tenant
 * is known (tenantResolver); this middleware is the outer, coarse gate.
 */

export interface CorsOptions {
  allowedOrigins: Set<string> | null;
}

export async function registerCors(
  app: FastifyInstance,
  options: CorsOptions,
): Promise<void> {
  if (options.allowedOrigins === null) {
    await app.register(fastifyCors, { origin: true, credentials: true });
    return;
  }

  const allowed = options.allowedOrigins;
  await app.register(fastifyCors, {
    credentials: true,
    origin: (origin, cb) => {
      if (!origin) return cb(null, false);
      cb(null, allowed.has(origin));
    },
  });
}
