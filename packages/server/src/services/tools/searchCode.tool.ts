import { ValidationError } from "../../shared/errors/index.js";
import { findAllowedRepo, type ToolContext, type ToolDefinition } from "./types.js";

/**
 * searchCode tool. Keyword search via GitHub's /search/code, restricted to
 * the caller's allowedRepos. Multi-repo scoped search = one call per
 * allowed repo; never issues a call for a repo outside the allowed set.
 *
 * If args.repo is provided, it must be in the allowed set — otherwise the
 * tool throws ValidationError("repo not in tenant scope") before hitting
 * the network.
 */

export interface SearchCodeArgs {
  query: string;
  repo?: string;
  limit?: number;
}

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 10;

export const searchCodeTool: ToolDefinition<SearchCodeArgs> = {
  name: "searchCode",
  description:
    "Keyword-search source files across the in-scope repositories. Returns a list of repo/path/url hits. Use for literal identifiers; prefer findSymbol for named symbols.",
  jsonSchema: {
    type: "object",
    additionalProperties: false,
    required: ["query"],
    properties: {
      query: { type: "string", description: "Keyword(s) to search for." },
      repo: {
        type: "string",
        description:
          'Optional "owner/name" — restrict search to this single repo. Must be in allowed scope.',
      },
      limit: { type: "integer", minimum: 1, maximum: MAX_LIMIT },
    },
  },

  async execute(args: SearchCodeArgs, ctx: ToolContext): Promise<string> {
    if (typeof args.query !== "string" || args.query.trim().length === 0) {
      throw new ValidationError("searchCode: query is required");
    }
    const limit = Math.min(
      Math.max(1, Math.floor(typeof args.limit === "number" ? args.limit : DEFAULT_LIMIT)),
      MAX_LIMIT,
    );

    const targetRepos = args.repo !== undefined
      ? (() => {
          const repo = findAllowedRepo(ctx, args.repo);
          if (!repo) throw new ValidationError("repo not in tenant scope");
          return [repo];
        })()
      : [...ctx.allowedRepos];

    if (targetRepos.length === 0) {
      return "no repositories in scope";
    }

    const lines: string[] = [];
    for (const repo of targetRepos) {
      const hits = await ctx.githubClient.searchFiles(
        args.query,
        { owner: repo.owner, name: repo.name, defaultBranch: repo.defaultBranch },
        repo.githubToken,
        { limit },
      );
      for (const hit of hits) {
        lines.push(`- ${hit.repo}: ${hit.path} (${hit.url})`);
      }
    }
    if (lines.length === 0) return "no hits";
    return lines.join("\n");
  },
};
