import type { Tenant } from "../config/tenants.js";
import type { IssueCreator } from "../infrastructure/issueCreator.js";
import { createCreateIssueTool } from "./tools/createIssue.tool.js";
import { findSymbolTool } from "./tools/findSymbol.tool.js";
import { readFileTool } from "./tools/readFile.tool.js";
import { searchCodeTool } from "./tools/searchCode.tool.js";
import { searchIssuesTool } from "./tools/searchIssues.tool.js";
import type { ToolDefinition } from "./tools/types.js";

/**
 * Default tool registry for the chat agent loop. Issue tools are registered
 * only when the tenant supplies a write token (belt-and-braces with tool
 * execute guards).
 */
export function buildDefaultAgentTools(tenant: Tenant, issueCreator: IssueCreator): ToolDefinition[] {
  const tools = [
    readFileTool,
    searchCodeTool,
    findSymbolTool,
    ...(tenant.issueConfig?.writeToken ? [createCreateIssueTool(issueCreator), searchIssuesTool] : []),
  ] as unknown as ToolDefinition[];
  return tools;
}
