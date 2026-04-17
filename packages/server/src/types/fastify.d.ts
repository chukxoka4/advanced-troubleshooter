import type { Tenant } from "../config/tenants.js";

declare module "fastify" {
  interface FastifyRequest {
    /**
     * Frozen tenant config attached by the tenantResolver middleware.
     * Downstream layers read it; nothing writes it.
     */
    tenant?: Readonly<Tenant>;
  }
}

export {};
