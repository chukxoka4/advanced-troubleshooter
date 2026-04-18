import { describe, expect, it, vi } from "vitest";
import type { DatabasePool } from "../infrastructure/db.js";
import { createRepoMapRepository } from "./repoMap.repository.js";

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

const sampleRow = {
  id: "id-1",
  tenant_id: "team-alpha",
  repo_full_name: "team-alpha/repo-a",
  default_branch: "main",
  head_sha: "abc",
  content: "map",
  symbol_count: 10,
  built_at: new Date(),
};

describe("repoMapRepository", () => {
  it("upsertMap includes tenant_id as the first INSERT param and uses ON CONFLICT", async () => {
    const { db, queryMock } = mockDb([sampleRow]);
    const repo = createRepoMapRepository(db);
    const saved = await repo.upsertMap({
      tenantId: "team-alpha",
      repoFullName: "team-alpha/repo-a",
      defaultBranch: "main",
      headSha: "abc",
      content: "map",
      symbolCount: 10,
    });
    expect(saved.tenantId).toBe("team-alpha");
    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/INSERT INTO repo_maps/);
    expect(sql).toMatch(/ON CONFLICT \(tenant_id, repo_full_name\)/);
    expect(params[0]).toBe("team-alpha");
    expect(params[1]).toBe("team-alpha/repo-a");
  });

  it("upsertMap throws on empty tenantId (defence in depth)", async () => {
    const { db } = mockDb();
    const repo = createRepoMapRepository(db);
    await expect(
      repo.upsertMap({
        tenantId: "",
        repoFullName: "x/y",
        defaultBranch: "main",
        headSha: "s",
        content: "c",
        symbolCount: 0,
      }),
    ).rejects.toThrow(/tenantId is required/);
  });

  it("upsertMap throws on empty repoFullName", async () => {
    const { db } = mockDb();
    const repo = createRepoMapRepository(db);
    await expect(
      repo.upsertMap({
        tenantId: "t",
        repoFullName: "",
        defaultBranch: "main",
        headSha: "s",
        content: "c",
        symbolCount: 0,
      }),
    ).rejects.toThrow(/repoFullName is required/);
  });

  it("getMap filters by both tenant_id and repo_full_name and returns null when absent", async () => {
    const { db, queryMock } = mockDb([]);
    const repo = createRepoMapRepository(db);
    const result = await repo.getMap("team-alpha", "team-alpha/repo-a");
    expect(result).toBeNull();
    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/WHERE tenant_id = \$1 AND repo_full_name = \$2/);
    expect(params).toEqual(["team-alpha", "team-alpha/repo-a"]);
  });

  it("getMap maps a found row correctly", async () => {
    const { db } = mockDb([sampleRow]);
    const repo = createRepoMapRepository(db);
    const result = await repo.getMap("team-alpha", "team-alpha/repo-a");
    expect(result?.repoFullName).toBe("team-alpha/repo-a");
    expect(result?.symbolCount).toBe(10);
  });

  it("getMap throws on empty tenantId", async () => {
    const { db } = mockDb();
    const repo = createRepoMapRepository(db);
    await expect(repo.getMap("", "x/y")).rejects.toThrow(/tenantId is required/);
  });

  it("listMapsForTenant filters by tenant_id only", async () => {
    const { db, queryMock } = mockDb([sampleRow]);
    const repo = createRepoMapRepository(db);
    await repo.listMapsForTenant("team-alpha");
    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/WHERE tenant_id = \$1/);
    expect(params).toEqual(["team-alpha"]);
  });

  it("listMapsForTenant throws on empty tenantId", async () => {
    const { db } = mockDb();
    const repo = createRepoMapRepository(db);
    await expect(repo.listMapsForTenant("")).rejects.toThrow(/tenantId is required/);
  });
});
