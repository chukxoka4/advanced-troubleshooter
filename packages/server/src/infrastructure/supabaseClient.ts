import { createDatabasePool, type DatabasePool } from "./db.js";

/**
 * Supabase is Postgres; in every environment (local Docker, hosted Supabase)
 * repositories talk to it through a single `pg` pool. This module owns that
 * pool as a process-wide singleton so repositories never hold their own
 * connections. The pool is created lazily on first access: tests that never
 * touch the DB do not open sockets, and importing the module is side-effect
 * free.
 */

let pool: DatabasePool | undefined;
let factory: (connectionString: string) => DatabasePool = createDatabasePool;

function requireConnectionString(): string {
  const value = process.env.DATABASE_URL;
  if (!value || value.length === 0) {
    throw new Error("DATABASE_URL is required to initialise the Supabase client");
  }
  return value;
}

export function getSupabaseClient(): DatabasePool {
  if (!pool) {
    pool = factory(requireConnectionString());
  }
  return pool;
}

export async function closeSupabaseClient(): Promise<void> {
  if (!pool) return;
  const current = pool;
  pool = undefined;
  await current.close();
}

/**
 * Test-only hook. Lets unit tests swap the pool factory and reset the
 * singleton between cases without touching a real database.
 */
export function _setSupabaseClientForTests(options: {
  factory?: (connectionString: string) => DatabasePool;
  pool?: DatabasePool | undefined;
}): void {
  if (options.factory) factory = options.factory;
  pool = options.pool;
}

export function _resetSupabaseClientForTests(): void {
  pool = undefined;
  factory = createDatabasePool;
}
