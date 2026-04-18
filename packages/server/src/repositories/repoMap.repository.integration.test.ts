import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { createDatabasePool, type DatabasePool } from "../infrastructure/db.js";
import { runMigrations } from "../../scripts/migrate.js";
import { createRepoMapRepository } from "./repoMap.repository.js";

/**
 * Integration test: spins up a fresh DB, applies migrations, exercises the
 * repository against real Postgres. Run via `npm run test:integration`.
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

const testDb = `repo_map_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
const testDbUrl = replaceDbName(ADMIN_URL, testDb);

let pool: DatabasePool;

describe("repoMapRepository (integration)", () => {
  beforeAll(async () => {
    const adminDb = dbNameFromUrl(ADMIN_URL);
    const admin = new Client({ connectionString: replaceDbName(ADMIN_URL, adminDb) });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${testDb}`);
    await admin.end();
    await runMigrations({ databaseUrl: testDbUrl });
    pool = createDatabasePool(testDbUrl);
  }, 30_000);

  afterAll(async () => {
    await pool?.close();
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

  it("does not leak maps across tenants", async () => {
    const repo = createRepoMapRepository(pool);
    await repo.upsertMap({
      tenantId: "team-alpha",
      repoFullName: "team-alpha/repo-a",
      defaultBranch: "main",
      headSha: "sha-alpha",
      content: "alpha content",
      symbolCount: 3,
    });
    await repo.upsertMap({
      tenantId: "team-beta",
      repoFullName: "team-alpha/repo-a",
      defaultBranch: "main",
      headSha: "sha-beta",
      content: "beta content",
      symbolCount: 1,
    });

    const betaFromAlpha = await repo.getMap("team-alpha", "team-beta/repo-a");
    expect(betaFromAlpha).toBeNull();

    const alphaList = await repo.listMapsForTenant("team-alpha");
    expect(alphaList).toHaveLength(1);
    expect(alphaList[0]?.headSha).toBe("sha-alpha");
  }, 30_000);

  it("upsertMap is idempotent on the (tenant_id, repo_full_name) unique key", async () => {
    const repo = createRepoMapRepository(pool);
    const first = await repo.upsertMap({
      tenantId: "team-gamma",
      repoFullName: "team-gamma/repo",
      defaultBranch: "main",
      headSha: "sha-1",
      content: "one",
      symbolCount: 1,
    });
    const second = await repo.upsertMap({
      tenantId: "team-gamma",
      repoFullName: "team-gamma/repo",
      defaultBranch: "main",
      headSha: "sha-2",
      content: "two",
      symbolCount: 2,
    });

    expect(second.id).toBe(first.id);
    expect(second.headSha).toBe("sha-2");
    expect(second.content).toBe("two");
    expect(second.symbolCount).toBe(2);

    const list = await repo.listMapsForTenant("team-gamma");
    expect(list).toHaveLength(1);
  }, 30_000);
});
