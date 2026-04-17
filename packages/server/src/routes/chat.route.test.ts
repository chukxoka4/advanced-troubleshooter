import Fastify, { type FastifyInstance } from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { Tenant } from "../config/tenants.js";
import type { LoadedTenants } from "../config/tenants.js";
import { registerAuth } from "../middleware/auth.js";
import { registerErrorHandler } from "../middleware/errorHandler.js";
import { registerTenantResolver } from "../middleware/tenantResolver.js";
import { NotFoundError } from "../shared/errors/index.js";
import type { AiService } from "../services/aiService.js";
import { registerChatRoute } from "./chat.js";

const VALID_UUID = "550e8400-e29b-41d4-a716-446655440000";

function makeTenant(tenantId = "team-alpha"): Tenant {
  return {
    tenantId,
    displayName: tenantId,
    repos: [
      { owner: "acme", name: "widgets", githubToken: "ghs_test", defaultBranch: "main" },
    ],
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

async function buildApp(
  aiService: AiService,
  options: { requireAuth: boolean } = { requireAuth: true },
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(
    async (scope) => {
      if (options.requireAuth) {
        await registerAuth(scope, { verifyApiKey: async (k) => k === "good-key" });
      }
      await registerTenantResolver(scope, { tenants: makeTenants([makeTenant()]) });
      await registerChatRoute(scope, { aiService });
    },
    { prefix: "/api/v1" },
  );
  return app;
}

function makeAiService(): AiService {
  return {
    askQuestion: vi.fn(async ({ sessionId, question }) => ({
      answer: `echo:${question}`,
      reposSearched: ["acme/widgets"],
      filesReferenced: ["acme/widgets:src/a.ts"],
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      estimatedCostUsd: 0,
      _sessionId: sessionId,
    })) as unknown as AiService["askQuestion"],
  };
}

describe("POST /api/v1/chat", () => {
  it("rejects requests without Authorization (403)", async () => {
    const app = await buildApp(makeAiService());
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/chat",
        headers: { "x-tenant-id": "team-alpha" },
        payload: { sessionId: VALID_UUID, message: "hi" },
      });
      expect(res.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });

  it("rejects requests without X-Tenant-Id (400)", async () => {
    const app = await buildApp(makeAiService());
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/chat",
        headers: { authorization: "Bearer good-key" },
        payload: { sessionId: VALID_UUID, message: "hi" },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it("rejects an unknown tenant (404)", async () => {
    const app = await buildApp(makeAiService());
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/chat",
        headers: { authorization: "Bearer good-key", "x-tenant-id": "ghost" },
        payload: { sessionId: VALID_UUID, message: "hi" },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it("rejects a malformed body (400)", async () => {
    const app = await buildApp(makeAiService());
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/chat",
        headers: { authorization: "Bearer good-key", "x-tenant-id": "team-alpha" },
        payload: { sessionId: "not-uuid", message: "" },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: "validation_error" });
    } finally {
      await app.close();
    }
  });

  it("returns 200 + answer for a valid request and calls the service with the resolved tenant", async () => {
    const service = makeAiService();
    const app = await buildApp(service);
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/chat",
        headers: { authorization: "Bearer good-key", "x-tenant-id": "team-alpha" },
        payload: { sessionId: VALID_UUID, message: "how do widgets work?" },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.sessionId).toBe(VALID_UUID);
      expect(body.answer).toBe("echo:how do widgets work?");
      expect(body.filesReferenced).toEqual([
        { repo: "acme/widgets", path: "src/a.ts" },
      ]);
      const askCall = (service.askQuestion as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
      expect(askCall.tenant.tenantId).toBe("team-alpha");
      expect(askCall.sessionId).toBe(VALID_UUID);
    } finally {
      await app.close();
    }
  });

  it("ignores tenantId if sent in the body (tenant comes from header only)", async () => {
    const service = makeAiService();
    const app = await buildApp(service);
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/chat",
        headers: { authorization: "Bearer good-key", "x-tenant-id": "team-alpha" },
        payload: { sessionId: VALID_UUID, message: "hi", tenantId: "attacker" },
      });
      expect(res.statusCode).toBe(200);
      const askCall = (service.askQuestion as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
      expect(askCall.tenant.tenantId).toBe("team-alpha");
    } finally {
      await app.close();
    }
  });
});
