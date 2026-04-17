import { afterAll, beforeAll, describe, it, expect } from "vitest";
import { Client } from "pg";
import { runMigrations } from "./migrate.js";

/**
 * Integration test: requires a running Postgres at DATABASE_URL (default:
 * the local docker-compose Postgres on port 5433). Excluded from the default
 * vitest run; execute via `npm run test:integration`.
 *
 * Each run creates and drops a uniquely-named database so it leaves no
 * side effects and can run in parallel with other integration tests.
 */

const ADMIN_URL =
  process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5433/app";

function dbNameFromUrl(url: string): string {
  return new URL(url).pathname.replace(/^\//, "") || "app";
}

function replaceDbName(url: string, newName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${newName}`;
  return parsed.toString();
}

const testDb = `migrate_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
const testDbUrl = replaceDbName(ADMIN_URL, testDb);

describe("runMigrations (integration)", () => {
  beforeAll(async () => {
    const adminDb = dbNameFromUrl(ADMIN_URL);
    const admin = new Client({ connectionString: replaceDbName(ADMIN_URL, adminDb) });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${testDb}`);
    await admin.end();
  }, 30_000);

  afterAll(async () => {
    const adminDb = dbNameFromUrl(ADMIN_URL);
    const admin = new Client({ connectionString: replaceDbName(ADMIN_URL, adminDb) });
    await admin.connect();
    await admin.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1",
      [testDb],
    );
    await admin.query(`DROP DATABASE IF EXISTS ${testDb}`);
    await admin.end();
  }, 30_000);

  it("applies every migration on a fresh database and creates the expected tables", async () => {
    const result = await runMigrations({ databaseUrl: testDbUrl });
    expect(result.applied).toContain("001_init.sql");
    expect(result.skipped).toHaveLength(0);

    const client = new Client({ connectionString: testDbUrl });
    await client.connect();
    try {
      const tables = await client.query<{ table_name: string }>(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'",
      );
      const names = tables.rows.map((row) => row.table_name);
      expect(names).toEqual(expect.arrayContaining([
        "conversations",
        "analytics_events",
        "api_keys",
        "schema_migrations",
      ]));
    } finally {
      await client.end();
    }
  }, 30_000);

  it("is idempotent: a second run applies nothing and skips the migration", async () => {
    const second = await runMigrations({ databaseUrl: testDbUrl });
    expect(second.applied).toHaveLength(0);
    expect(second.skipped).toContain("001_init.sql");
  }, 30_000);
});
