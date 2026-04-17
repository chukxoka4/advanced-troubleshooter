import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

/**
 * Idempotent migration runner. Applies every *.sql file under db/migrations/
 * in alphabetical order, recording each applied file in schema_migrations so
 * re-runs become no-ops. Intentionally minimal — a real migration tool is a
 * production concern; this covers the prototype's needs while keeping the
 * migrations themselves in plain .sql.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(__dirname, "..", "db", "migrations");

const CREATE_TRACKING_TABLE = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    name        TEXT PRIMARY KEY,
    applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
`;

export interface MigrateOptions {
  databaseUrl: string;
  migrationsDir?: string;
  log?: (message: string) => void;
}

export interface MigrateResult {
  applied: string[];
  skipped: string[];
}

export async function runMigrations(options: MigrateOptions): Promise<MigrateResult> {
  const dir = options.migrationsDir ?? MIGRATIONS_DIR;
  const log = options.log ?? (() => undefined);

  const entries = await readdir(dir);
  const migrationFiles = entries.filter((file) => file.endsWith(".sql")).sort();

  const client = new Client({ connectionString: options.databaseUrl });
  await client.connect();
  const applied: string[] = [];
  const skipped: string[] = [];

  try {
    await client.query(CREATE_TRACKING_TABLE);

    for (const file of migrationFiles) {
      const alreadyApplied = await client.query<{ name: string }>(
        "SELECT name FROM schema_migrations WHERE name = $1",
        [file],
      );
      if ((alreadyApplied.rowCount ?? 0) > 0) {
        skipped.push(file);
        log(`skip ${file}`);
        continue;
      }

      const sql = await readFile(join(dir, file), "utf8");
      log(`apply ${file}`);
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
        await client.query("COMMIT");
        applied.push(file);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
  } finally {
    await client.end();
  }

  return { applied, skipped };
}

const isEntryPoint =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("migrate.ts") === true ||
  process.argv[1]?.endsWith("migrate.js") === true;

if (isEntryPoint) {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL is required");
    process.exit(1);
  }

  runMigrations({ databaseUrl, log: (msg) => console.log(msg) })
    .then((result) => {
      console.log(
        `migrations complete: applied=${result.applied.length} skipped=${result.skipped.length}`,
      );
    })
    .catch((error) => {
      console.error("migration failed:", error);
      process.exit(1);
    });
}
