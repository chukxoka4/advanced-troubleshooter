import { describe, expect, it, vi } from "vitest";
import type { DatabasePool } from "../infrastructure/db.js";
import { createAnalyticsRepository } from "./analytics.repository.js";

function mockDb(): { db: DatabasePool; queryMock: ReturnType<typeof vi.fn> } {
  const queryMock = vi.fn(async () => ({ rows: [] }));
  const db = {
    ping: vi.fn(),
    close: vi.fn(),
    query: queryMock as unknown as DatabasePool["query"],
  } as unknown as DatabasePool;
  return { db, queryMock };
}

describe("analyticsRepository", () => {
  it("logEvent inserts tenant_id, event type, and serialised metadata", async () => {
    const { db, queryMock } = mockDb();
    const repo = createAnalyticsRepository(db);
    await repo.logEvent({
      tenantId: "team-alpha",
      sessionId: "s1",
      eventType: "query",
      latencyMs: 120,
      reposCount: 3,
      metadata: { provider: "claude", model: "claude-sonnet-4-6" },
    });
    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/INSERT INTO analytics_events/);
    expect(params[0]).toBe("team-alpha");
    expect(params[2]).toBe("query");
    expect(params[3]).toBe(120);
    expect(params[4]).toBe(3);
    expect(params[5]).toBeNull();
    expect(params[6]).toBe(JSON.stringify({ provider: "claude", model: "claude-sonnet-4-6" }));
  });

  it("logEvent requires tenantId", async () => {
    const { db } = mockDb();
    const repo = createAnalyticsRepository(db);
    await expect(
      repo.logEvent({ tenantId: "", sessionId: "s", eventType: "query" }),
    ).rejects.toThrow(/tenantId is required/);
  });

  it("logEvent rejects out-of-range feedbackRating", async () => {
    const { db } = mockDb();
    const repo = createAnalyticsRepository(db);
    await expect(
      repo.logEvent({
        tenantId: "t",
        sessionId: "s",
        eventType: "feedback",
        feedbackRating: 9,
      }),
    ).rejects.toThrow(/between 1 and 5/);
  });

  it("logEvent passes nulls for omitted optional fields", async () => {
    const { db, queryMock } = mockDb();
    const repo = createAnalyticsRepository(db);
    await repo.logEvent({ tenantId: "t", sessionId: "s", eventType: "issue_draft" });
    const [, params] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(params.slice(3)).toEqual([null, null, null, null]);
  });
});
