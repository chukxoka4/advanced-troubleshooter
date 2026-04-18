import { ValidationError } from "../../shared/errors/index.js";
import type { TenantRepo } from "../repoScope.service.js";
import { findAllowedRepo, type ToolContext, type ToolDefinition } from "./types.js";

/**
 * findSymbol tool. Looks up symbol names in the pre-built repo maps
 * (written by repoMap.service) for the caller's allowedRepos only.
 *
 * Unknown symbol → empty array (rendered as "no matches"). Never throws
 * on "not found"; reserves throws for scope violations and malformed input.
 *
 * Repo-map text format (produced by repoMap.service.renderFileBlock) looks
 * like:
 *   ## owner/name (branch: main)
 *
 *   ### path/to/file.ts
 *   - L1-5 function foo: function foo(): void
 *   - L7-10 class Bar: class Bar
 *
 * Parsing is line-based and tolerant of whitespace — this is an internal
 * producer/consumer pair so the format is stable, but the parser fails
 * soft (ignores malformed lines) rather than throwing.
 */

export interface FindSymbolArgs {
  symbol: string;
  repo?: string;
}

export interface SymbolMatch {
  repo: string;
  path: string;
  lineStart: number;
  lineEnd: number;
  signature: string;
}

const FILE_HEADER_RE = /^###\s+(.+?)\s*$/;
const SYMBOL_LINE_RE =
  /^-\s+L(\d+)-(\d+)\s+(class|function|method|const|type)\s+(\S+)\s*:\s*(.+?)\s*$/;

function parseMapContent(content: string, repoFullName: string): SymbolMatch[] {
  const out: SymbolMatch[] = [];
  let currentPath: string | null = null;
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine;
    const fileMatch = FILE_HEADER_RE.exec(line);
    if (fileMatch) {
      currentPath = fileMatch[1] ?? null;
      continue;
    }
    const symMatch = SYMBOL_LINE_RE.exec(line);
    if (!symMatch || !currentPath) continue;
    const [, lStart, lEnd, , name, sig] = symMatch;
    out.push({
      repo: repoFullName,
      path: currentPath,
      lineStart: Number(lStart),
      lineEnd: Number(lEnd),
      signature: `${name} — ${sig}`,
    });
  }
  return out;
}

export const findSymbolTool: ToolDefinition<FindSymbolArgs> = {
  name: "findSymbol",
  description:
    "Look up a symbol (class / function / method / const / type) by name in the repo map. Returns matches with repo, path, and line range. Scoped to allowed repos only.",
  jsonSchema: {
    type: "object",
    additionalProperties: false,
    required: ["symbol"],
    properties: {
      symbol: { type: "string", description: "Symbol name to search for (exact or substring)." },
      repo: {
        type: "string",
        description: 'Optional "owner/name" to restrict the search to one allowed repo.',
      },
    },
  },

  async execute(args: FindSymbolArgs, ctx: ToolContext): Promise<string> {
    if (typeof args.symbol !== "string" || args.symbol.trim().length === 0) {
      throw new ValidationError("findSymbol: symbol is required");
    }

    const targets: TenantRepo[] = args.repo !== undefined
      ? (() => {
          const repo = findAllowedRepo(ctx, args.repo);
          if (!repo) throw new ValidationError("repo not in tenant scope");
          return [repo];
        })()
      : [...ctx.allowedRepos];

    const needle = args.symbol.toLowerCase();
    const matches: SymbolMatch[] = [];
    for (const repo of targets) {
      const repoFullName = `${repo.owner}/${repo.name}`;
      const map = await ctx.repoMapRepository.getMap(ctx.tenant.tenantId, repoFullName);
      if (!map) continue;
      const parsed = parseMapContent(map.content, repoFullName);
      for (const m of parsed) {
        // Extract the bare name from "kind — signature" for comparison.
        const [namePart] = m.signature.split(" — ", 1);
        const bare = namePart ?? "";
        if (bare.toLowerCase().includes(needle)) matches.push(m);
      }
    }

    if (matches.length === 0) return "no matches";
    return matches
      .map((m) => `- ${m.repo}:${m.path} L${m.lineStart}-${m.lineEnd} ${m.signature}`)
      .join("\n");
  },
};

// Exposed for tests.
export const __internal = { parseMapContent };
