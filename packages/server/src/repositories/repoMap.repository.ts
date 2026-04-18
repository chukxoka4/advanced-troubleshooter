import type { DatabasePool } from "../infrastructure/db.js";

/**
 * Repo-map repository. Every query filters by tenant_id — there is no
 * getter that returns rows across tenants. Upserts are keyed on the
 * (tenant_id, repo_full_name) unique index.
 */

export interface RepoMapRow {
  id: string;
  tenantId: string;
  repoFullName: string;
  defaultBranch: string;
  headSha: string;
  content: string;
  symbolCount: number;
  builtAt: Date;
}

export interface UpsertRepoMapInput {
  tenantId: string;
  repoFullName: string;
  defaultBranch: string;
  headSha: string;
  content: string;
  symbolCount: number;
}

export interface RepoMapRepository {
  upsertMap(input: UpsertRepoMapInput): Promise<RepoMapRow>;
  getMap(tenantId: string, repoFullName: string): Promise<RepoMapRow | null>;
  listMapsForTenant(tenantId: string): Promise<RepoMapRow[]>;
}

interface DbRepoMapRow {
  id: string;
  tenant_id: string;
  repo_full_name: string;
  default_branch: string;
  head_sha: string;
  content: string;
  symbol_count: number;
  built_at: Date;
}

function mapRow(row: DbRepoMapRow): RepoMapRow {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    repoFullName: row.repo_full_name,
    defaultBranch: row.default_branch,
    headSha: row.head_sha,
    content: row.content,
    symbolCount: row.symbol_count,
    builtAt: row.built_at,
  };
}

export function createRepoMapRepository(db: DatabasePool): RepoMapRepository {
  return {
    async upsertMap(input) {
      if (!input.tenantId) throw new Error("repoMap.upsertMap: tenantId is required");
      if (!input.repoFullName) throw new Error("repoMap.upsertMap: repoFullName is required");
      const { rows } = await db.query<DbRepoMapRow>(
        `INSERT INTO repo_maps
           (tenant_id, repo_full_name, default_branch, head_sha, content, symbol_count)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (tenant_id, repo_full_name) DO UPDATE SET
           default_branch = EXCLUDED.default_branch,
           head_sha       = EXCLUDED.head_sha,
           content        = EXCLUDED.content,
           symbol_count   = EXCLUDED.symbol_count,
           built_at       = NOW()
         RETURNING id, tenant_id, repo_full_name, default_branch, head_sha,
                   content, symbol_count, built_at`,
        [
          input.tenantId,
          input.repoFullName,
          input.defaultBranch,
          input.headSha,
          input.content,
          input.symbolCount,
        ],
      );
      const row = rows[0];
      if (!row) throw new Error("repoMap.upsertMap: upsert returned no row");
      return mapRow(row);
    },

    async getMap(tenantId, repoFullName) {
      if (!tenantId) throw new Error("repoMap.getMap: tenantId is required");
      const { rows } = await db.query<DbRepoMapRow>(
        `SELECT id, tenant_id, repo_full_name, default_branch, head_sha,
                content, symbol_count, built_at
         FROM repo_maps
         WHERE tenant_id = $1 AND repo_full_name = $2
         LIMIT 1`,
        [tenantId, repoFullName],
      );
      const row = rows[0];
      return row ? mapRow(row) : null;
    },

    async listMapsForTenant(tenantId) {
      if (!tenantId) throw new Error("repoMap.listMapsForTenant: tenantId is required");
      const { rows } = await db.query<DbRepoMapRow>(
        `SELECT id, tenant_id, repo_full_name, default_branch, head_sha,
                content, symbol_count, built_at
         FROM repo_maps
         WHERE tenant_id = $1
         ORDER BY repo_full_name ASC`,
        [tenantId],
      );
      return rows.map(mapRow);
    },
  };
}
