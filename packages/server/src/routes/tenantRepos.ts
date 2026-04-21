import type { FastifyInstance } from "fastify";
import { TenantReposResponseSchema, type TenantReposResponse } from "@advanced-troubleshooter/shared";
import { ValidationError } from "../shared/errors/index.js";

/**
 * GET /api/v1/tenant/repos — lists repos for the resolved tenant with
 * default-scope flags for the repo picker UI.
 */

export async function registerTenantReposRoute(app: FastifyInstance): Promise<void> {
  app.get("/tenant/repos", async (req, reply): Promise<TenantReposResponse> => {
    const tenant = req.tenant;
    if (!tenant) throw new ValidationError("tenant context is required");
    const defaults = new Set(tenant.defaultRepoScope ?? []);
    const body: TenantReposResponse = {
      repos: tenant.repos.map((r) => {
        const fullName = `${r.owner}/${r.name}`;
        return { owner: r.owner, name: r.name, fullName, isDefault: defaults.has(fullName) };
      }),
    };
    return reply.code(200).send(TenantReposResponseSchema.parse(body));
  });
}
