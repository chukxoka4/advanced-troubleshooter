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

/**
 * POST /api/v1/chat
 *
 * `sessionId` is a UUIDv4 minted on the client and persisted per browser
 * session. It scopes conversation history reads (a session only ever sees
 * its own turns). `tenantId` is deliberately NOT part of the body — it
 * travels in the X-Tenant-Id header and is resolved by middleware, so
 * clients cannot spoof a different tenant through the request payload.
 */
const REPO_FULL_NAME = /^[^/]+\/[^/]+$/;

export const ChatRequestSchema = z.object({
  sessionId: z.string().uuid("sessionId must be a UUIDv4"),
  message: z
    .string()
    .min(1, "message is required")
    .max(4_000, "message must be at most 4000 characters"),
  repoScope: z
    .array(z.string().regex(REPO_FULL_NAME, "each repoScope entry must be owner/name"))
    .optional(),
});
export type ChatRequest = z.infer<typeof ChatRequestSchema>;

export const ChatCitationSchema = z.object({
  repo: z.string(),
  path: z.string(),
  lineStart: z.number().int().positive().optional(),
  lineEnd: z.number().int().positive().optional(),
});
export type ChatCitation = z.infer<typeof ChatCitationSchema>;

export const ChatToolCallSchema = z.object({
  name: z.string(),
  ok: z.boolean(),
  errorMessage: z.string().optional(),
});
export type ChatToolCall = z.infer<typeof ChatToolCallSchema>;

export const ChatResponseSchema = z.object({
  sessionId: z.string().uuid(),
  answer: z.string(),
  reposScoped: z.array(z.string()),
  reposTouched: z.array(z.string()),
  filesReferenced: z.array(ChatCitationSchema),
  toolCalls: z.array(ChatToolCallSchema).optional(),
});
export type ChatResponse = z.infer<typeof ChatResponseSchema>;

export const TenantRepoEntrySchema = z.object({
  owner: z.string(),
  name: z.string(),
  fullName: z.string(),
  isDefault: z.boolean(),
});
export type TenantRepoEntry = z.infer<typeof TenantRepoEntrySchema>;

export const TenantReposResponseSchema = z.object({
  repos: z.array(TenantRepoEntrySchema),
});
export type TenantReposResponse = z.infer<typeof TenantReposResponseSchema>;
