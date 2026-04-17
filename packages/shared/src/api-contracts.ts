import { z } from "zod";

/**
 * API request/response contracts shared between the server and the frontend.
 * Schemas are added alongside the routes that validate against them.
 */

export const HealthCheckResultSchema = z.enum(["ok", "degraded"]);
export type HealthCheckResult = z.infer<typeof HealthCheckResultSchema>;

export const HealthResponseSchema = z.object({
  status: HealthCheckResultSchema,
  version: z.string(),
  gitSha: z.string().nullable(),
  appMode: z.enum(["prototype", "production"]),
  uptimeMs: z.number().int().nonnegative(),
  checks: z.object({
    database: HealthCheckResultSchema,
  }),
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;
