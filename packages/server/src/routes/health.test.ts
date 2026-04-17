import Fastify from "fastify";
import { describe, it, expect } from "vitest";
import { buildHealthResponse, registerHealthRoutes, type HealthDependencies } from "./health.js";

function baseDeps(overrides: Partial<HealthDependencies> = {}): HealthDependencies {
  return {
    db: { ping: async () => true },
    appMode: "prototype",
    version: "0.1.2",
    gitSha: "abc123def",
    startedAt: 1_000_000,
    now: () => 1_000_500,
    ...overrides,
  };
}

describe("buildHealthResponse", () => {
  it("returns status=ok when every check is ok", async () => {
    const body = await buildHealthResponse(baseDeps());
    expect(body).toEqual({
      status: "ok",
      version: "0.1.2",
      gitSha: "abc123def",
      appMode: "prototype",
      uptimeMs: 500,
      checks: { database: "ok" },
    });
  });

  it("returns status=degraded when the database ping fails", async () => {
    const body = await buildHealthResponse(
      baseDeps({ db: { ping: async () => false } }),
    );
    expect(body.status).toBe("degraded");
    expect(body.checks.database).toBe("degraded");
  });

  it("returns degraded when the database ping throws", async () => {
    const body = await buildHealthResponse(
      baseDeps({
        db: {
          ping: async () => {
            throw new Error("connection refused");
          },
        },
      }),
    );
    expect(body.status).toBe("degraded");
    expect(body.checks.database).toBe("degraded");
  });

  it("reflects appMode=production", async () => {
    const body = await buildHealthResponse(baseDeps({ appMode: "production" }));
    expect(body.appMode).toBe("production");
  });

  it("allows gitSha to be null", async () => {
    const body = await buildHealthResponse(baseDeps({ gitSha: null }));
    expect(body.gitSha).toBeNull();
  });
});

describe("registerHealthRoutes", () => {
  it("GET /health returns 200 and JSON body when healthy", async () => {
    const app = Fastify({ logger: false });
    await registerHealthRoutes(app, baseDeps());
    try {
      const response = await app.inject({ method: "GET", url: "/health" });
      expect(response.statusCode).toBe(200);
      const body = response.json() as { status: string; appMode: string };
      expect(body.status).toBe("ok");
      expect(body.appMode).toBe("prototype");
    } finally {
      await app.close();
    }
  });

  it("GET /health returns 503 when the database is down", async () => {
    const app = Fastify({ logger: false });
    await registerHealthRoutes(
      app,
      baseDeps({ db: { ping: async () => false } }),
    );
    try {
      const response = await app.inject({ method: "GET", url: "/health" });
      expect(response.statusCode).toBe(503);
      const body = response.json() as { status: string };
      expect(body.status).toBe("degraded");
    } finally {
      await app.close();
    }
  });

  it("GET /health/deep is exposed with the same shape", async () => {
    const app = Fastify({ logger: false });
    await registerHealthRoutes(app, baseDeps());
    try {
      const response = await app.inject({ method: "GET", url: "/health/deep" });
      expect(response.statusCode).toBe(200);
      expect((response.json() as { status: string }).status).toBe("ok");
    } finally {
      await app.close();
    }
  });

  it("does not require authorization or tenant headers", async () => {
    const app = Fastify({ logger: false });
    await registerHealthRoutes(app, baseDeps());
    try {
      const response = await app.inject({ method: "GET", url: "/health" });
      expect(response.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
});
