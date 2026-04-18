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

const REPO_FULL_NAME_PATTERN = /^[^/]+\/[^/]+$/;

export const TenantConfigSchema = z
  .object({
    tenantId: z.string().min(1).regex(/^[a-z0-9-]+$/, "tenantId must be lowercase kebab-case"),
    displayName: z.string().min(1),
    repos: z.array(RepoSchema).min(1),
    issueConfig: IssueConfigSchema.optional(),
    ai: AiSchema,
    systemPrompt: z.string().min(1),
    allowedOrigins: z.array(z.string()).default([]),
    allowedUsers: z.array(z.string()).default([]),
    /**
     * Optional whitelist of "owner/name" identifiers the assistant may
     * reason about by default. Every entry MUST (1) match the owner/name
     * regex and (2) reference a repo already declared in `repos`. The
     * scoping gate in Day 5 uses this list when the request does not
     * specify an explicit repoScope.
     */
    defaultRepoScope: z.array(z.string().regex(REPO_FULL_NAME_PATTERN)).optional(),
    rateLimits: RateLimitsSchema,
  })
  .superRefine((tenant, ctx) => {
    if (!tenant.defaultRepoScope) return;
    const declared = new Set(tenant.repos.map((r) => `${r.owner}/${r.name}`));
    for (let i = 0; i < tenant.defaultRepoScope.length; i += 1) {
      const entry = tenant.defaultRepoScope[i] as string;
      if (!declared.has(entry)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["defaultRepoScope", i],
          message: `defaultRepoScope entry "${entry}" does not reference a repo declared in tenant.repos`,
        });
      }
    }
  });

export type Tenant = z.infer<typeof TenantConfigSchema>;
export type AiProvider = z.infer<typeof AiProviderSchema>;
