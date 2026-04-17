import type { FastifyInstance, FastifyRequest } from "fastify";
import { ValidationError } from "../shared/errors/index.js";
import type { LoadedTenants } from "../config/tenants.js";

/**
 * tenantResolver middleware.
 *
 * Reads the tenant from the X-Tenant-Id header, looks it up in the loaded
 * tenants map (which throws NotFoundError for unknown IDs), freezes the
 * record, and attaches it to req.tenant for downstream handlers.
 *
 * Freezing is defensive — services and repositories receive a tenant object
 * they cannot mutate, which eliminates a whole class of accidental
 * cross-request state changes.
 */

const TENANT_HEADER = "x-tenant-id";

export interface TenantResolverOptions {
  tenants: LoadedTenants;
}

function readTenantHeader(req: FastifyRequest): string {
  const value = req.headers[TENANT_HEADER];
  if (Array.isArray(value)) {
    throw new ValidationError(`${TENANT_HEADER} header must be a single value`);
  }
  if (!value) {
    throw new ValidationError(`${TENANT_HEADER} header is required`);
  }
  return value;
}

export async function registerTenantResolver(
  app: FastifyInstance,
  options: TenantResolverOptions,
): Promise<void> {
  app.addHook("onRequest", async (req: FastifyRequest) => {
    const tenantId = readTenantHeader(req);
    const tenant = options.tenants.getTenant(tenantId);
    req.tenant = Object.freeze(tenant);
  });
}
