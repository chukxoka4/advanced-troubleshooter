import { ValidationError } from "../../shared/errors/index.js";
import { findAllowedRepo, type ToolContext, type ToolDefinition } from "./types.js";

/**
 * readFile tool. Reads a clamped line range from a file in an in-scope repo.
 *
 * Scope gate: rejects with ValidationError("repo not in tenant scope") BEFORE
 * any githubClient call. The agent-loop dispatcher re-validates — defence in
 * depth.
 *
 * Returns a human/model-readable string so the result is trivially embeddable
 * in a ToolResult. Binary (non-UTF8) files return a fixed marker rather than
 * attempting to render bytes.
 */

export interface ReadFileArgs {
  repo: string;
  path: string;
  startLine?: number;
  endLine?: number;
}

const MAX_RANGE_LINES = 400;
const BINARY_MARKER = "binary file, not readable";

function looksBinary(content: string): boolean {
  // Presence of NUL bytes in a "utf8"-decoded buffer is the usual signal that
  // the underlying bytes were not text.
  return content.includes("\u0000");
}

export const readFileTool: ToolDefinition<ReadFileArgs> = {
  name: "readFile",
  description:
    "Read a line range from a file inside one of the in-scope repositories. Returns the slice with its repo, path, and clamped line range.",
  jsonSchema: {
    type: "object",
    additionalProperties: false,
    required: ["repo", "path"],
    properties: {
      repo: {
        type: "string",
        description: 'Full repo name, "owner/name". Must be in the caller\'s allowed scope.',
      },
      path: { type: "string", description: "Path of the file in the repo." },
      startLine: { type: "integer", minimum: 1 },
      endLine: { type: "integer", minimum: 1 },
    },
  },

  async execute(args: ReadFileArgs, ctx: ToolContext): Promise<string> {
    const repo = findAllowedRepo(ctx, args.repo);
    if (!repo) throw new ValidationError("repo not in tenant scope");
    if (typeof args.path !== "string" || args.path.length === 0) {
      throw new ValidationError("readFile: path is required");
    }

    // Reject NaN / ±Infinity up front. `typeof NaN === "number"`, so the
    // previous `typeof === "number"` check alone would let NaN through and
    // Math.floor(NaN) would silently become NaN and propagate as a bogus
    // range to the github client.
    if (args.startLine !== undefined && !Number.isFinite(args.startLine)) {
      throw new ValidationError("readFile: startLine must be a finite number");
    }
    if (args.endLine !== undefined && !Number.isFinite(args.endLine)) {
      throw new ValidationError("readFile: endLine must be a finite number");
    }

    const startRaw = typeof args.startLine === "number" ? args.startLine : 1;
    const endRaw =
      typeof args.endLine === "number" ? args.endLine : startRaw + MAX_RANGE_LINES - 1;
    const start = Math.max(1, Math.floor(startRaw));
    const end = Math.max(start, Math.floor(endRaw));
    const cappedEnd = Math.min(end, start + MAX_RANGE_LINES - 1);

    const range = await ctx.githubClient.readFileRange(
      {
        owner: repo.owner,
        name: repo.name,
        defaultBranch: repo.defaultBranch,
      },
      args.path,
      start,
      cappedEnd,
      repo.githubToken,
    );

    if (looksBinary(range.content)) {
      return BINARY_MARKER;
    }

    // The untrusted-data envelope is applied uniformly at the agent-loop
    // layer across ALL tool outputs, not here. See agentLoop.service.ts.
    return [
      `path: ${range.repo}:${range.path}`,
      `lines: ${range.startLine}-${range.endLine}`,
      range.content,
    ].join("\n");
  },
};
