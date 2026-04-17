import { createDatabasePool } from "../src/infrastructure/db.js";
import { createApiKeyRepository } from "../src/repositories/apiKey.repository.js";
import { createApiKeyService } from "../src/services/apiKeyService.js";

/**
 * Admin CLI: mint a new tenant API key.
 *
 *   npm run create-api-key -- --tenant team-alpha --label "prod embed"
 *
 * Prints the plaintext exactly once on stdout. The plaintext is NEVER
 * written to a log, a file, or an analytics event — the operator must
 * capture it from this single print. The hash is stored via the API key
 * repository; losing the plaintext means re-running this script.
 */

interface CliArgs {
  tenant: string;
  label?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args: Partial<CliArgs> = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if ((flag === "--tenant" || flag === "-t") && value) {
      args.tenant = value;
      i++;
    } else if ((flag === "--label" || flag === "-l") && value) {
      args.label = value;
      i++;
    }
  }
  if (!args.tenant) {
    throw new Error("usage: create-api-key --tenant <tenantId> [--label <text>]");
  }
  return args as CliArgs;
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }
  const args = parseArgs(process.argv.slice(2));

  const pool = createDatabasePool(databaseUrl);
  try {
    const repo = createApiKeyRepository(pool);
    const service = createApiKeyService({ repository: repo });
    const { plaintext, row } = await service.generate({
      tenantId: args.tenant,
      ...(args.label ? { label: args.label } : {}),
    });
    // Intentional single write to stdout. Do not log the plaintext anywhere
    // else. Operators pipe this straight into a password manager.
    process.stdout.write(
      `api key id: ${row.id}\ntenant:     ${row.tenantId}\nlabel:      ${row.label ?? "(none)"}\nplaintext:  ${plaintext}\n`,
    );
  } finally {
    await pool.close();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`create-api-key failed: ${message}\n`);
  process.exit(1);
});
