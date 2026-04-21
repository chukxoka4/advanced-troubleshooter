import Fastify, { type FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import type { Tenant } from "../config/tenants.js";
import type { LoadedTenants } from "../config/tenants.js";
import { registerAuth } from "../middleware/auth.js";
import { registerErrorHandler } from "../middleware/errorHandler.js";
import { registerTenantResolver } from "../middleware/tenantResolver.js";
import { NotFoundError } from "../shared/errors/index.js";
import { registerTenantReposRoute } from "./tenantRepos.js";

function makeTenant(): Tenant {
  return {
    tenantId: "team-alpha",
    displayName: "Alpha",
    repos: [
      { owner: "acme", name: "widgets", githubToken: "ghs_test", defaultBranch: "main" },
      { owner: "acme", name: "docs", githubToken: "ghs_test2", defaultBranch: "main" },
    ],
    defaultRepoScope: ["acme/widgets"],
    ai: {
      provider: "claude",
      model: "claude-sonnet-4-6",
      apiKey: "sk-test",
      dailySpendCapUsd: 5,
    },
    systemPrompt: "sp",
    allowedOrigins: [],
    allowedUsers: [],
    rateLimits: { questionsPerMinute: 60, issuesPerHour: 30 },
  } as Tenant;
}

function makeTenants(tenants: Tenant[]): LoadedTenants {
  const byId = new Map(tenants.map((t) => [t.tenantId, t]));
  return {
    getTenant(id) {
      const t = byId.get(id);
      if (!t) throw new NotFoundError(`tenant ${id} not found`);
      return t;
    },
    allTenantIds: () => [...byId.keys()],
    all: () => [...byId.values()],
  };
}

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(
    async (scope) => {
      await registerAuth(scope, { verifyApiKey: async (k) => k === "good-key" });
      await registerTenantResolver(scope, { tenants: makeTenants([makeTenant()]) });
      await registerTenantReposRoute(scope);
    },
    { prefix: "/api/v1" },
  );
  return app;
}

describe("GET /api/v1/tenant/repos", () => {
  it("requires auth", async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/tenant/repos",
        headers: { "x-tenant-id": "team-alpha" },
      });
      expect(res.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });

  it("returns repos with isDefault from tenant.defaultRepoScope", async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/tenant/repos",
        headers: { authorization: "Bearer good-key", "x-tenant-id": "team-alpha" },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { repos: Array<{ fullName: string; isDefault: boolean }> };
      expect(body.repos).toHaveLength(2);
      const w = body.repos.find((r) => r.fullName === "acme/widgets");
      const d = body.repos.find((r) => r.fullName === "acme/docs");
      expect(w?.isDefault).toBe(true);
      expect(d?.isDefault).toBe(false);
    } finally {
      await app.close();
    }
  });
});
