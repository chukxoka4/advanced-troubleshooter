import type { DatabasePool } from "../infrastructure/db.js";

/**
 * API key repository. The plaintext key is never stored — callers hash it
 * before handing a value to this layer (the repository does not know or
 * care how; it just writes/reads the hash). Revoked keys are filtered from
 * lookups so the auth middleware can treat "not found" and "revoked"
 * identically.
 */

export interface ApiKeyRow {
  id: string;
  tenantId: string;
  label: string | null;
  createdAt: Date;
  revokedAt: Date | null;
}

export interface StoreKeyHashInput {
  tenantId: string;
  keyHash: string;
  label?: string;
}

export interface ApiKeyRepository {
  storeKeyHash(input: StoreKeyHashInput): Promise<ApiKeyRow>;
  findByKeyHash(keyHash: string): Promise<ApiKeyRow | null>;
  revoke(id: string): Promise<void>;
}

interface DbApiKeyRow {
  id: string;
  tenant_id: string;
  label: string | null;
  created_at: Date;
  revoked_at: Date | null;
}

function mapRow(row: DbApiKeyRow): ApiKeyRow {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    label: row.label,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
  };
}

function assertHash(keyHash: string): void {
  if (!keyHash || keyHash.length < 32) {
    throw new Error("apiKey repository: refusing to store a suspiciously short hash");
  }
  if (/^ghp_|^github_pat_|^sk-/i.test(keyHash)) {
    throw new Error("apiKey repository: refusing to store what looks like a plaintext key");
  }
}

export function createApiKeyRepository(db: DatabasePool): ApiKeyRepository {
  return {
    async storeKeyHash(input) {
      if (!input.tenantId) throw new Error("apiKey.storeKeyHash: tenantId is required");
      assertHash(input.keyHash);
      const { rows } = await db.query<DbApiKeyRow>(
        `INSERT INTO api_keys (tenant_id, key_hash, label)
         VALUES ($1, $2, $3)
         RETURNING id, tenant_id, label, created_at, revoked_at`,
        [input.tenantId, input.keyHash, input.label ?? null],
      );
      const row = rows[0];
      if (!row) throw new Error("apiKey.storeKeyHash: insert returned no row");
      return mapRow(row);
    },

    async findByKeyHash(keyHash) {
      if (!keyHash) return null;
      const { rows } = await db.query<DbApiKeyRow>(
        `SELECT id, tenant_id, label, created_at, revoked_at
         FROM api_keys
         WHERE key_hash = $1 AND revoked_at IS NULL
         LIMIT 1`,
        [keyHash],
      );
      const row = rows[0];
      return row ? mapRow(row) : null;
    },

    async revoke(id) {
      if (!id) throw new Error("apiKey.revoke: id is required");
      await db.query(
        `UPDATE api_keys SET revoked_at = NOW() WHERE id = $1 AND revoked_at IS NULL`,
        [id],
      );
    },
  };
}
