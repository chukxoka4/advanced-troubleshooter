import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { createDatabasePool, type DatabasePool } from "../infrastructure/db.js";
import { runMigrations } from "../../scripts/migrate.js";
import { createConversationRepository } from "./conversation.repository.js";

/**
 * Integration test: spins up a fresh DB, applies migrations, exercises the
 * repository against real Postgres. The test DB is dropped on teardown.
 * Run via `npm run test:integration`.
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

const testDb = `conv_repo_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
const testDbUrl = replaceDbName(ADMIN_URL, testDb);

let pool: DatabasePool;

describe("conversationRepository (integration)", () => {
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

  it("does not leak rows across tenants", async () => {
    const repo = createConversationRepository(pool);
    await repo.saveMessage({
      tenantId: "team-alpha",
      sessionId: "shared-session",
      role: "agent",
      message: "alpha question",
    });
    await repo.saveMessage({
      tenantId: "team-beta",
      sessionId: "shared-session",
      role: "agent",
      message: "beta question",
    });

    const alphaRows = await repo.getHistory("team-alpha", "shared-session");
    const betaRows = await repo.getHistory("team-beta", "shared-session");

    expect(alphaRows.map((r) => r.message)).toEqual(["alpha question"]);
    expect(betaRows.map((r) => r.message)).toEqual(["beta question"]);
  });

  it("excludes soft-deleted rows", async () => {
    const repo = createConversationRepository(pool);
    const saved = await repo.saveMessage({
      tenantId: "team-gamma",
      sessionId: "s-delete",
      role: "agent",
      message: "to be deleted",
    });
    await pool.query("UPDATE conversations SET deleted_at = NOW() WHERE id = $1", [saved.id]);
    const rows = await repo.getHistory("team-gamma", "s-delete");
    expect(rows).toHaveLength(0);
  });

  it("returns messages in chronological order", async () => {
    const repo = createConversationRepository(pool);
    for (let i = 0; i < 5; i++) {
      await repo.saveMessage({
        tenantId: "team-order",
        sessionId: "s-order",
        role: i % 2 === 0 ? "agent" : "assistant",
        message: `msg-${i}`,
      });
    }
    const rows = await repo.getHistory("team-order", "s-order");
    expect(rows.map((r) => r.message)).toEqual(["msg-0", "msg-1", "msg-2", "msg-3", "msg-4"]);
  });
});
