-- 001_init.sql
-- Initial schema for the advanced-troubleshooter server.
-- Applied by scripts/migrate.ts in alphabetical order and recorded in
-- the schema_migrations table so re-runs are safe.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE conversations (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         TEXT NOT NULL,
  session_id        TEXT NOT NULL,
  role              TEXT NOT NULL CHECK (role IN ('agent', 'assistant')),
  message           TEXT NOT NULL,
  repos_searched    TEXT[],
  files_referenced  TEXT[],
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at        TIMESTAMPTZ
);

CREATE INDEX idx_conversations_session ON conversations(session_id);
CREATE INDEX idx_conversations_tenant  ON conversations(tenant_id);

CREATE TABLE analytics_events (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         TEXT NOT NULL,
  session_id        TEXT NOT NULL,
  event_type        TEXT NOT NULL,
  latency_ms        INTEGER,
  repos_count       INTEGER,
  feedback_rating   INTEGER CHECK (feedback_rating BETWEEN 1 AND 5),
  metadata          JSONB,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_analytics_tenant ON analytics_events(tenant_id);

CREATE TABLE api_keys (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         TEXT NOT NULL,
  key_hash          TEXT NOT NULL UNIQUE,
  label             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at        TIMESTAMPTZ
);

CREATE INDEX idx_api_keys_hash ON api_keys(key_hash) WHERE revoked_at IS NULL;
