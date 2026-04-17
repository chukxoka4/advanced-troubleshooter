import Fastify, { type FastifyInstance } from "fastify";
import { describe, it, expect } from "vitest";
import { NotFoundError } from "../shared/errors/index.js";
import type { LoadedTenants, Tenant } from "../config/tenants.js";
import { registerErrorHandler } from "./errorHandler.js";
import { registerTenantResolver } from "./tenantResolver.js";

function fakeTenant(id: string): Tenant {
  return {
    tenantId: id,
    displayName: id,
    repos: [
      { owner: "acme", name: "widget", githubToken: "token", defaultBranch: "main" },
    ],
    ai: {
      provider: "openai",
      model: "gpt-4o",
      apiKey: "key",
      dailySpendCapUsd: 10,
    },
    systemPrompt: "prompt",
    allowedOrigins: [],
    allowedUsers: [],
    rateLimits: { questionsPerMinute: 10, issuesPerHour: 20 },
  };
}

function fakeLoadedTenants(tenants: Tenant[]): LoadedTenants {
  const byId = new Map(tenants.map((t) => [t.tenantId, t]));
  return {
    getTenant(id) {
      const t = byId.get(id);
      if (!t) throw new NotFoundError(`tenant "${id}" not found`);
      return t;
    },
    allTenantIds: () => [...byId.keys()],
    all: () => [...byId.values()],
  };
}

async function buildApp(tenants: LoadedTenants): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  registerErrorHandler(app);
  await registerTenantResolver(app, { tenants });
  return app;
}

describe("tenantResolver middleware", () => {
  it("attaches a frozen tenant when the header resolves", async () => {
    const app = await buildApp(fakeLoadedTenants([fakeTenant("team-alpha")]));
    app.get("/", async (req) => ({
      tenantId: req.tenant?.tenantId,
      frozen: Object.isFrozen(req.tenant),
    }));
    try {
      const response = await app.inject({
        method: "GET",
        url: "/",
        headers: { "x-tenant-id": "team-alpha" },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ tenantId: "team-alpha", frozen: true });
    } finally {
      await app.close();
    }
  });

  it("returns 400 validation_error when the header is missing", async () => {
    const app = await buildApp(fakeLoadedTenants([fakeTenant("team-alpha")]));
    app.get("/", async () => ({ ok: true }));
    try {
      const response = await app.inject({ method: "GET", url: "/" });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: "validation_error" });
    } finally {
      await app.close();
    }
  });

  it("returns 404 not_found for an unknown tenant", async () => {
    const app = await buildApp(fakeLoadedTenants([fakeTenant("team-alpha")]));
    app.get("/", async () => ({ ok: true }));
    try {
      const response = await app.inject({
        method: "GET",
        url: "/",
        headers: { "x-tenant-id": "team-beta" },
      });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ error: "not_found" });
    } finally {
      await app.close();
    }
  });

});
