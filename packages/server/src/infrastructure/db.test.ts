import { describe, it, expect, vi, beforeEach } from "vitest";

const queryMock = vi.fn();
const endMock = vi.fn();

vi.mock("pg", () => {
  class MockPool {
    query = queryMock;
    end = endMock;
  }
  return { default: { Pool: MockPool }, Pool: MockPool };
});

import { createDatabasePool } from "./db.js";

describe("createDatabasePool", () => {
  beforeEach(() => {
    queryMock.mockReset();
    endMock.mockReset();
  });

  it("ping returns true when SELECT 1 succeeds", async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ ok: 1 }] });
    const db = createDatabasePool("postgres://noop");
    expect(await db.ping()).toBe(true);
    expect(queryMock).toHaveBeenCalledWith("SELECT 1 AS ok");
  });

  it("ping returns false when the query rejects", async () => {
    queryMock.mockRejectedValueOnce(new Error("connection refused"));
    const db = createDatabasePool("postgres://noop");
    expect(await db.ping()).toBe(false);
  });

  it("ping returns false when the query returns no rows", async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    const db = createDatabasePool("postgres://noop");
    expect(await db.ping()).toBe(false);
  });

  it("ping returns false when the ok sentinel is wrong", async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ ok: 0 }] });
    const db = createDatabasePool("postgres://noop");
    expect(await db.ping()).toBe(false);
  });

  it("close calls pool.end()", async () => {
    endMock.mockResolvedValueOnce(undefined);
    const db = createDatabasePool("postgres://noop");
    await db.close();
    expect(endMock).toHaveBeenCalledOnce();
  });
});
