import type { IssueCreator } from "../../infrastructure/issueCreator.js";
import { ValidationError } from "../../shared/errors/index.js";
import type { ToolDefinition } from "./types.js";

export interface CreateIssueArgs {
  repo: string;
  title: string;
  body: string;
  labels?: string[];
}

export function createCreateIssueTool(issueCreator: IssueCreator): ToolDefinition<CreateIssueArgs> {
  return {
    name: "createIssue",
    description:
      "Open a new GitHub issue in the tenant-configured target repository. Requires the issue target repo as `repo`.",
    jsonSchema: {
      type: "object",
      additionalProperties: false,
      required: ["repo", "title", "body"],
      properties: {
        repo: { type: "string", description: 'Must equal the tenant issue target "owner/name".' },
        title: { type: "string" },
        body: { type: "string" },
        labels: { type: "array", items: { type: "string" } },
      },
    },

    async execute(args, ctx) {
      const cfg = ctx.tenant.issueConfig;
      if (!cfg?.writeToken) {
        throw new ValidationError("issue creation is not available");
      }
      if (typeof args.repo !== "string" || args.repo !== cfg.targetRepo) {
        throw new ValidationError("repo not in tenant scope");
      }
      if (typeof args.title !== "string" || !args.title.trim()) {
        throw new ValidationError("createIssue: title is required");
      }
      if (typeof args.body !== "string") {
        throw new ValidationError("createIssue: body is required");
      }
      const labels = Array.isArray(args.labels)
        ? args.labels.filter((l): l is string => typeof l === "string")
        : undefined;
      const payload =
        labels !== undefined && labels.length > 0
          ? { title: args.title.trim(), body: args.body, labels }
          : { title: args.title.trim(), body: args.body };
      const created = await issueCreator.create(cfg.targetRepo, payload, cfg.writeToken);
      return JSON.stringify({ url: created.url, number: created.number });
    },
  };
}
