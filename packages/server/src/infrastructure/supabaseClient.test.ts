import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabasePool } from "./db.js";
import {
  _resetSupabaseClientForTests,
  _setSupabaseClientForTests,
  closeSupabaseClient,
  getSupabaseClient,
} from "./supabaseClient.js";

function makeFakePool(): DatabasePool & { __id: number } {
  return {
    __id: Math.random(),
    ping: vi.fn(async () => true),
    close: vi.fn(async () => undefined),
    query: vi.fn() as unknown as DatabasePool["query"],
  };
}

describe("supabaseClient singleton", () => {
  const originalUrl = process.env.DATABASE_URL;

  beforeEach(() => {
    _resetSupabaseClientForTests();
    process.env.DATABASE_URL = "postgres://noop/test";
  });

  afterEach(() => {
    _resetSupabaseClientForTests();
    if (originalUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalUrl;
  });

  it("creates the pool once and reuses it on subsequent calls", () => {
    const factory = vi.fn((_cs: string) => makeFakePool());
    _setSupabaseClientForTests({ factory });

    const first = getSupabaseClient();
    const second = getSupabaseClient();

    expect(first).toBe(second);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(factory).toHaveBeenCalledWith("postgres://noop/test");
  });

  it("throws when DATABASE_URL is unset", () => {
    delete process.env.DATABASE_URL;
    const factory = vi.fn((_cs: string) => makeFakePool());
    _setSupabaseClientForTests({ factory });
    expect(() => getSupabaseClient()).toThrow(/DATABASE_URL is required/);
    expect(factory).not.toHaveBeenCalled();
  });

  it("closeSupabaseClient closes the pool and clears the singleton", async () => {
    const pool = makeFakePool();
    const factory = vi.fn((_cs: string) => pool);
    _setSupabaseClientForTests({ factory });

    getSupabaseClient();
    await closeSupabaseClient();

    expect(pool.close).toHaveBeenCalledOnce();
    getSupabaseClient();
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it("closeSupabaseClient is a no-op when no pool has been created", async () => {
    await expect(closeSupabaseClient()).resolves.toBeUndefined();
  });
});
