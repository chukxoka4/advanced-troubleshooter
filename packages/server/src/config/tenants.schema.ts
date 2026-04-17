import { z } from "zod";

/**
 * Tenant configuration schema. Every field that references a secret is a
 * string; the loader resolves ${ENV_VAR} placeholders to real values before
 * this schema runs, so schema failures point at the final resolved shape.
 */

const RepoSchema = z.object({
  owner: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  githubToken: z.string().min(1),
  defaultBranch: z.string().min(1).default("main"),
});

const IssueConfigSchema = z.object({
  targetRepo: z.string().regex(/^[^/]+\/[^/]+$/, "targetRepo must be owner/repo"),
  writeToken: z.string().min(1).optional(),
  templates: z.array(z.string()).default([]),
});

export const AiProviderSchema = z.enum(["claude", "openai", "gemini"]);

const AiSchema = z.object({
  provider: AiProviderSchema,
  model: z.string().min(1),
  apiKey: z.string().min(1),
  dailySpendCapUsd: z.number().positive(),
});

const RateLimitsSchema = z.object({
  questionsPerMinute: z.number().positive(),
  issuesPerHour: z.number().positive(),
});

export const TenantConfigSchema = z.object({
  tenantId: z.string().min(1).regex(/^[a-z0-9-]+$/, "tenantId must be lowercase kebab-case"),
  displayName: z.string().min(1),
  repos: z.array(RepoSchema).min(1),
  issueConfig: IssueConfigSchema.optional(),
  ai: AiSchema,
  systemPrompt: z.string().min(1),
  allowedOrigins: z.array(z.string()).default([]),
  allowedUsers: z.array(z.string()).default([]),
  rateLimits: RateLimitsSchema,
});

export type Tenant = z.infer<typeof TenantConfigSchema>;
export type AiProvider = z.infer<typeof AiProviderSchema>;
