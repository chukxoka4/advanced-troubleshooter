import type { Tenant } from "../config/tenants.js";
import { ValidationError } from "../shared/errors/index.js";

/**
 * Repo-scope validation gate. Pure, no I/O. This is the SINGLE place a
 * request-scope array is turned into an allowedRepos list. Every tool call
 * and prompt-rendering code path downstream is required to derive its
 * allowed set from this function's return value.
 *
 * Fallback order: request.repoScope → tenant.defaultRepoScope → tenant.repos.
 *
 * Any entry not declared in tenant.repos throws ValidationError with the
 * exact message "repo not in tenant scope" — deliberately no echo of the
 * attempted identifier, to avoid cross-tenant repo enumeration via errors.
 */

export type TenantRepo = Tenant["repos"][number];

export interface RepoScopeRequest {
  repoScope?: string[];
}

export interface RepoScopeResult {
  allowedRepos: ReadonlyArray<TenantRepo>;
}

function fullName(r: TenantRepo): string {
  return `${r.owner}/${r.name}`;
}

export function validate(request: RepoScopeRequest, tenant: Tenant): RepoScopeResult {
  const declared = new Map<string, TenantRepo>();
  for (const r of tenant.repos) declared.set(fullName(r), r);

  const candidate =
    request.repoScope !== undefined
      ? request.repoScope
      : tenant.defaultRepoScope !== undefined
        ? tenant.defaultRepoScope
        : tenant.repos.map(fullName);

  const resolved: TenantRepo[] = [];
  for (const entry of candidate) {
    const match = declared.get(entry);
    if (!match) throw new ValidationError("repo not in tenant scope");
    resolved.push(match);
  }

  return { allowedRepos: Object.freeze(resolved) };
}
