import { describe, expect, it, vi } from "vitest";
import type { DatabasePool } from "../infrastructure/db.js";
import { createConversationRepository } from "./conversation.repository.js";

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

describe("conversationRepository", () => {
  it("saveMessage always includes tenant_id in the INSERT parameters", async () => {
    const { db, queryMock } = mockDb([
      {
        id: "id-1",
        tenant_id: "team-alpha",
        session_id: "s1",
        role: "agent",
        message: "hello",
        repos_searched: null,
        files_referenced: null,
        created_at: new Date(),
      },
    ]);
    const repo = createConversationRepository(db);
    const saved = await repo.saveMessage({
      tenantId: "team-alpha",
      sessionId: "s1",
      role: "agent",
      message: "hello",
    });

    expect(saved.tenantId).toBe("team-alpha");
    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/INSERT INTO conversations/);
    expect(params[0]).toBe("team-alpha");
    expect(params).toHaveLength(6);
    expect(params[4]).toEqual([]);
    expect(params[5]).toEqual([]);
  });

  it("saveMessage throws when tenantId is empty (defence in depth)", async () => {
    const { db } = mockDb();
    const repo = createConversationRepository(db);
    await expect(
      repo.saveMessage({ tenantId: "", sessionId: "s", role: "agent", message: "m" }),
    ).rejects.toThrow(/tenantId is required/);
  });

  it("getHistory filters by both tenant_id and session_id and excludes soft-deleted rows", async () => {
    const { db, queryMock } = mockDb([]);
    const repo = createConversationRepository(db);
    await repo.getHistory("team-alpha", "sess-1", 25);

    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/WHERE tenant_id = \$1/);
    expect(sql).toMatch(/AND session_id = \$2/);
    expect(sql).toMatch(/AND deleted_at IS NULL/);
    expect(sql).toMatch(/ORDER BY created_at ASC/);
    expect(params).toEqual(["team-alpha", "sess-1", 25]);
  });

  it("getHistory throws when tenantId is empty", async () => {
    const { db } = mockDb();
    const repo = createConversationRepository(db);
    await expect(repo.getHistory("", "s")).rejects.toThrow(/tenantId is required/);
  });

  it("getHistory maps repos_searched/files_referenced nulls to empty arrays", async () => {
    const { db } = mockDb([
      {
        id: "1",
        tenant_id: "t",
        session_id: "s",
        role: "assistant",
        message: "m",
        repos_searched: null,
        files_referenced: null,
        created_at: new Date(),
      },
    ]);
    const repo = createConversationRepository(db);
    const rows = await repo.getHistory("t", "s");
    expect(rows[0]?.reposSearched).toEqual([]);
    expect(rows[0]?.filesReferenced).toEqual([]);
  });
});
