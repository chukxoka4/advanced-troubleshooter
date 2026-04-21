import type { Tenant } from "../config/tenants.js";
import type { IssueCreator } from "../infrastructure/issueCreator.js";
import { createCreateIssueTool } from "./tools/createIssue.tool.js";
import { findSymbolTool } from "./tools/findSymbol.tool.js";
import { readFileTool } from "./tools/readFile.tool.js";
import { searchCodeTool } from "./tools/searchCode.tool.js";
import { searchIssuesTool } from "./tools/searchIssues.tool.js";
import type { ToolDefinition } from "./tools/types.js";

/** `issueConfig.targetRepo` is backed by a `tenant.repos` entry (read token). */
export function tenantHasIssueSearchTarget(tenant: Tenant): boolean {
  const target = tenant.issueConfig?.targetRepo;
  if (!target) return false;
  const [owner, name] = target.split("/");
  if (!owner || !name) return false;
  return tenant.repos.some((r) => r.owner === owner && r.name === name);
}

/**
 * Default tool registry for the chat agent loop. `searchIssues` is
 * registered when the issue target repo exists on the tenant (read token).
 * `createIssue` is registered only when a write token is configured.
 */
export function buildDefaultAgentTools(tenant: Tenant, issueCreator: IssueCreator): ToolDefinition[] {
  const tools: ToolDefinition[] = [
    readFileTool,
    searchCodeTool,
    findSymbolTool,
  ] as unknown as ToolDefinition[];
  if (tenantHasIssueSearchTarget(tenant)) {
    tools.push(searchIssuesTool as unknown as ToolDefinition);
  }
  if (tenant.issueConfig?.writeToken && tenant.issueConfig.targetRepo) {
    tools.push(createCreateIssueTool(issueCreator) as unknown as ToolDefinition);
  }
  return tools as unknown as ToolDefinition[];
}
