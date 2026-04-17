import Fastify, { type FastifyInstance } from "fastify";
import { describe, it, expect } from "vitest";
import { registerErrorHandler } from "./errorHandler.js";
import { registerRateLimiter } from "./rateLimiter.js";

async function buildApp(options: Parameters<typeof registerRateLimiter>[1]): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  registerErrorHandler(app);
  await registerRateLimiter(app, options);
  app.get("/", async () => ({ ok: true }));
  return app;
}

describe("rate limiter middleware", () => {
  it("allows requests under the per-minute limit", async () => {
    const app = await buildApp({ getLimit: () => 3 });
    try {
      for (let i = 0; i < 3; i++) {
        const response = await app.inject({ method: "GET", url: "/" });
        expect(response.statusCode).toBe(200);
      }
    } finally {
      await app.close();
    }
  });

  it("returns 429 rate_limited on the (limit+1)-th request within the window", async () => {
    const app = await buildApp({ getLimit: () => 2 });
    try {
      await app.inject({ method: "GET", url: "/" });
      await app.inject({ method: "GET", url: "/" });
      const response = await app.inject({ method: "GET", url: "/" });
      expect(response.statusCode).toBe(429);
      expect(response.json()).toMatchObject({ error: "rate_limited" });
    } finally {
      await app.close();
    }
  });

  it("resets the bucket once the window has elapsed", async () => {
    let now = 1_000_000;
    const app = await buildApp({
      getLimit: () => 1,
      now: () => now,
    });
    try {
      const first = await app.inject({ method: "GET", url: "/" });
      expect(first.statusCode).toBe(200);

      const blocked = await app.inject({ method: "GET", url: "/" });
      expect(blocked.statusCode).toBe(429);

      now += 60_001;
      const afterWindow = await app.inject({ method: "GET", url: "/" });
      expect(afterWindow.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it("keys buckets by tenant so one tenant cannot exhaust another's quota", async () => {
    const app = Fastify({ logger: false });
    registerErrorHandler(app);
    app.addHook("onRequest", async (req) => {
      const tenant = req.headers["x-fake-tenant"] as string | undefined;
      if (tenant) {
        req.tenant = Object.freeze({ tenantId: tenant } as never);
      }
    });
    await registerRateLimiter(app, { getLimit: () => 1 });
    app.get("/", async () => ({ ok: true }));

    try {
      const a1 = await app.inject({
        method: "GET",
        url: "/",
        headers: { "x-fake-tenant": "team-a" },
      });
      expect(a1.statusCode).toBe(200);

      const b1 = await app.inject({
        method: "GET",
        url: "/",
        headers: { "x-fake-tenant": "team-b" },
      });
      expect(b1.statusCode).toBe(200);

      const a2 = await app.inject({
        method: "GET",
        url: "/",
        headers: { "x-fake-tenant": "team-a" },
      });
      expect(a2.statusCode).toBe(429);
    } finally {
      await app.close();
    }
  });
});
