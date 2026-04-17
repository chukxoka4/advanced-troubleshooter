import type { FastifyInstance, FastifyRequest } from "fastify";
import { isPrototype } from "../config/appMode.js";
import type { LoadedTenants } from "../config/tenants.js";
import { registerCors } from "./cors.js";
import { registerAuth, type VerifyApiKey } from "./auth.js";
import { registerTenantResolver } from "./tenantResolver.js";
import { registerRateLimiter } from "./rateLimiter.js";
import { registerErrorHandler } from "./errorHandler.js";

/**
 * Wires the protected middleware chain (CORS → Auth → TenantResolver →
 * RateLimiter) and returns its context. Callers pass an encapsulated
 * plugin scope so public routes like /health can be registered outside
 * of the protected scope; the global error handler is attached at the
 * root app so every request benefits from domain-error mapping.
 */

const PROTOTYPE_REQUESTS_PER_MINUTE = 1_000;

export interface MiddlewareContext {
  tenants: LoadedTenants;
  verifyApiKey: VerifyApiKey;
}

function buildAllowedOrigins(tenants: LoadedTenants): Set<string> {
  const allowed = new Set<string>();
  for (const tenant of tenants.all()) {
    for (const origin of tenant.allowedOrigins) allowed.add(origin);
  }
  return allowed;
}

function resolveLimitForRequest(req: FastifyRequest): number {
  if (isPrototype()) return PROTOTYPE_REQUESTS_PER_MINUTE;
  return req.tenant?.rateLimits.questionsPerMinute ?? PROTOTYPE_REQUESTS_PER_MINUTE;
}

export async function registerProtectedMiddleware(
  scope: FastifyInstance,
  ctx: MiddlewareContext,
): Promise<void> {
  const allowedOrigins = isPrototype() ? null : buildAllowedOrigins(ctx.tenants);
  await registerCors(scope, { allowedOrigins });
  await registerAuth(scope, { verifyApiKey: ctx.verifyApiKey });
  await registerTenantResolver(scope, { tenants: ctx.tenants });
  await registerRateLimiter(scope, { getLimit: resolveLimitForRequest });
}

export function registerGlobalErrorHandler(app: FastifyInstance): void {
  registerErrorHandler(app);
}
