import type { Logger } from "pino";
import type { Tenant } from "../../config/tenants.js";
import type { GithubMcpClient } from "../../infrastructure/githubClient.js";
import type { RepoMapRepository } from "../../repositories/repoMap.repository.js";
import type { IssueCreateRateGate } from "../issueCreateRateGate.service.js";
import type { TenantRepo } from "../repoScope.service.js";

/**
 * Shared tool-execution context passed to every tool's `execute`. Tools
 * NEVER reach for globals — every dependency flows through this object.
 *
 * `allowedRepos` is the frozen list returned by repoScope.service.validate.
 * A tool MUST re-check `args.repo ∈ allowedRepos` before any side effect.
 * The agent-loop dispatcher also validates — belt and braces.
 */
export interface ToolContext {
  tenant: Tenant;
  allowedRepos: ReadonlyArray<TenantRepo>;
  githubClient: GithubMcpClient;
  repoMapRepository: RepoMapRepository;
  logger: Pick<Logger, "info" | "warn" | "error" | "debug">;
  issueCreateRateGate?: IssueCreateRateGate;
}

export interface ToolDefinition<TArgs = Record<string, unknown>> {
  readonly name: string;
  readonly description: string;
  readonly jsonSchema: Record<string, unknown>;
  execute(args: TArgs, ctx: ToolContext): Promise<string>;
}

export function findAllowedRepo(
  ctx: ToolContext,
  repoFullName: unknown,
): TenantRepo | null {
  if (typeof repoFullName !== "string") return null;
  for (const r of ctx.allowedRepos) {
    if (`${r.owner}/${r.name}` === repoFullName) return r;
  }
  return null;
}
