import { describe, expect, it, vi } from "vitest";
import type { DatabasePool } from "../infrastructure/db.js";
import { createApiKeyRepository } from "./apiKey.repository.js";

function mockDb(rows: unknown[] = []): {
  db: DatabasePool;
  queryMock: ReturnType<typeof vi.fn>;
} {
  const queryMock = vi.fn(async () => ({ rows }));
  const db = {
    ping: vi.fn(),
    close: vi.fn(),
    query: queryMock as unknown as DatabasePool["query"],
  } as unknown as DatabasePool;
  return { db, queryMock };
}

const LONG_HASH = "a".repeat(60);

describe("apiKeyRepository", () => {
  it("storeKeyHash inserts only hash + tenant_id + label (never plaintext)", async () => {
    const { db, queryMock } = mockDb([
      { id: "id-1", tenant_id: "team-a", label: null, created_at: new Date(), revoked_at: null },
    ]);
    const repo = createApiKeyRepository(db);
    const row = await repo.storeKeyHash({ tenantId: "team-a", keyHash: LONG_HASH });
    expect(row.tenantId).toBe("team-a");
    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/INSERT INTO api_keys/);
    expect(params).toEqual(["team-a", LONG_HASH, null]);
  });

  it("storeKeyHash rejects a plaintext-looking value (defence in depth)", async () => {
    const { db } = mockDb();
    const repo = createApiKeyRepository(db);
    await expect(
      repo.storeKeyHash({ tenantId: "t", keyHash: "ghp_thisIsObviouslyATokenPleaseNo" }),
    ).rejects.toThrow(/plaintext key/);
  });

  it("storeKeyHash rejects an implausibly short hash", async () => {
    const { db } = mockDb();
    const repo = createApiKeyRepository(db);
    await expect(repo.storeKeyHash({ tenantId: "t", keyHash: "short" })).rejects.toThrow(
      /short hash/,
    );
  });

  it("findByKeyHash excludes revoked keys", async () => {
    const { db, queryMock } = mockDb([]);
    const repo = createApiKeyRepository(db);
    const result = await repo.findByKeyHash(LONG_HASH);
    expect(result).toBeNull();
    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/revoked_at IS NULL/);
    expect(params).toEqual([LONG_HASH]);
  });

  it("findByKeyHash returns null for empty input without hitting the DB", async () => {
    const { db, queryMock } = mockDb();
    const repo = createApiKeyRepository(db);
    const result = await repo.findByKeyHash("");
    expect(result).toBeNull();
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("revoke sets revoked_at only for rows not already revoked", async () => {
    const { db, queryMock } = mockDb();
    const repo = createApiKeyRepository(db);
    await repo.revoke("id-1");
    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/UPDATE api_keys SET revoked_at = NOW\(\)/);
    expect(sql).toMatch(/revoked_at IS NULL/);
    expect(params).toEqual(["id-1"]);
  });
});
