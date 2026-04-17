import type { FastifyInstance } from "fastify";
import type { AppMode } from "../config/appMode.js";

/**
 * /health and /health/deep.
 *
 * /health is the always-public liveness probe that Railway and the frontend
 * can call without an API key or tenant header. It returns the overall
 * status (ok | degraded), the app mode, the build version, uptime, and a
 * flat map of component checks. Currently only Postgres is checked — GitHub
 * and LLM provider pings plug into /health/deep as clients are added in
 * later phases.
 *
 * /health/deep accepts the same response shape but its checks run against
 * external services that are slow or expensive to ping on every probe.
 * Callers (oncall, scheduled monitors) opt into them explicitly.
 */

export type CheckResult = "ok" | "degraded";
export type OverallStatus = "ok" | "degraded";

export interface HealthChecks {
  database: CheckResult;
}

export interface HealthResponse {
  status: OverallStatus;
  version: string;
  gitSha: string | null;
  appMode: AppMode;
  uptimeMs: number;
  checks: HealthChecks;
}

export interface HealthDependencies {
  db: { ping: () => Promise<boolean> };
  appMode: AppMode;
  version: string;
  gitSha: string | null;
  now?: () => number;
  startedAt?: number;
}

async function runDatabaseCheck(
  db: HealthDependencies["db"],
): Promise<CheckResult> {
  try {
    return (await db.ping()) ? "ok" : "degraded";
  } catch {
    return "degraded";
  }
}

function aggregate(checks: HealthChecks): OverallStatus {
  return Object.values(checks).every((c) => c === "ok") ? "ok" : "degraded";
}

export async function buildHealthResponse(
  deps: HealthDependencies,
): Promise<HealthResponse> {
  const now = deps.now ?? (() => Date.now());
  const startedAt = deps.startedAt ?? now();
  const checks: HealthChecks = {
    database: await runDatabaseCheck(deps.db),
  };
  return {
    status: aggregate(checks),
    version: deps.version,
    gitSha: deps.gitSha,
    appMode: deps.appMode,
    uptimeMs: now() - startedAt,
    checks,
  };
}

export async function registerHealthRoutes(
  app: FastifyInstance,
  deps: HealthDependencies,
): Promise<void> {
  app.get("/health", async (_req, reply) => {
    const body = await buildHealthResponse(deps);
    const statusCode = body.status === "ok" ? 200 : 503;
    return reply.code(statusCode).send(body);
  });

  app.get("/health/deep", async (_req, reply) => {
    const body = await buildHealthResponse(deps);
    const statusCode = body.status === "ok" ? 200 : 503;
    return reply.code(statusCode).send(body);
  });
}
