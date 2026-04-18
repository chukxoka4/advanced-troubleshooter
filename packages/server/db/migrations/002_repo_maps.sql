-- 002_repo_maps.sql
-- Per-repo, per-tenant symbol outline produced by tree-sitter. One row per
-- (tenant_id, repo_full_name); upserted when the head SHA changes. Content
-- is text (signatures + line ranges) and safe to embed in the agent's
-- system prompt.

CREATE TABLE IF NOT EXISTS repo_maps (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       TEXT NOT NULL,
  repo_full_name  TEXT NOT NULL,
  default_branch  TEXT NOT NULL,
  head_sha        TEXT NOT NULL,
  content         TEXT NOT NULL,
  symbol_count    INTEGER NOT NULL,
  built_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, repo_full_name)
);

CREATE INDEX IF NOT EXISTS idx_repo_maps_tenant ON repo_maps(tenant_id);
