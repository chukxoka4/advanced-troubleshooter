import pg from "pg";

/**
 * Thin wrapper around a pg connection pool. The server talks to Postgres
 * exclusively through this interface so repositories and health checks can
 * be unit-tested against an in-memory double.
 *
 * Creation is eager (pool is constructed) but connection is lazy — pg only
 * opens a TCP connection when the first query runs. That means server boot
 * does not depend on Postgres being reachable; the /health endpoint surfaces
 * the actual reachability state.
 */

export interface DatabasePool {
  ping: () => Promise<boolean>;
  close: () => Promise<void>;
  query: pg.Pool["query"];
}

export function createDatabasePool(connectionString: string): DatabasePool {
  const pool = new pg.Pool({ connectionString });
  return {
    async ping(): Promise<boolean> {
      try {
        const result = await pool.query<{ ok: number }>("SELECT 1 AS ok");
        return result.rows.length === 1 && result.rows[0]?.ok === 1;
      } catch {
        return false;
      }
    },
    async close(): Promise<void> {
      await pool.end();
    },
    query: pool.query.bind(pool) as pg.Pool["query"],
  };
}
