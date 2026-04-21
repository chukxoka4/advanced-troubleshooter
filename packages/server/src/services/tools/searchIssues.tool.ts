import { ValidationError } from "../../shared/errors/index.js";
import type { ToolDefinition } from "./types.js";

export interface SearchIssuesArgs {
  repo: string;
  query: string;
  limit?: number;
}

const MAX_LIMIT = 30;

export const searchIssuesTool: ToolDefinition<SearchIssuesArgs> = {
  name: "searchIssues",
  description:
    "Search existing issues in the tenant-configured target repository. Returns titles and URLs only.",
  jsonSchema: {
    type: "object",
    additionalProperties: false,
    required: ["repo", "query"],
    properties: {
      repo: { type: "string", description: 'Must equal the tenant issue target "owner/name".' },
      query: { type: "string" },
      limit: { type: "integer", minimum: 1, maximum: MAX_LIMIT },
    },
  },

  async execute(args, ctx) {
    const cfg = ctx.tenant.issueConfig;
    if (!cfg?.writeToken) {
      throw new ValidationError("issue search is not available");
    }
    if (typeof args.repo !== "string" || args.repo !== cfg.targetRepo) {
      throw new ValidationError("repo not in tenant scope");
    }
    if (typeof args.query !== "string" || !args.query.trim()) {
      throw new ValidationError("searchIssues: query is required");
    }
    const [owner, name] = cfg.targetRepo.split("/");
    const repoCfg = ctx.tenant.repos.find((r) => r.owner === owner && r.name === name);
    if (!repoCfg) {
      throw new ValidationError("repo not in tenant scope");
    }
    const limit =
      typeof args.limit === "number" && Number.isFinite(args.limit)
        ? Math.min(Math.max(1, Math.floor(args.limit)), MAX_LIMIT)
        : undefined;
    const searchOpts = limit !== undefined ? { limit } : {};
    const hits = await ctx.githubClient.searchIssues(
      cfg.targetRepo,
      args.query.trim(),
      repoCfg.githubToken,
      searchOpts,
    );
    if (hits.length === 0) return "No matching issues.";
    return hits.map((h) => `- ${h.title}: ${h.url}`).join("\n");
  },
};
