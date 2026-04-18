/**
 * refresh-maps CLI. Loads every tenant config and calls
 * repoMapService.refresh() for each (tenant, repo) pair. Idempotent: when
 * the repo's head SHA matches the stored map the service is a no-op, so
 * the script is safe to run on a cron.
 */
import { loadTenants } from "../src/config/tenants.js";
import { createDatabasePool } from "../src/infrastructure/db.js";
import { createGithubMcpClient } from "../src/infrastructure/githubClient.js";
import { createRepoMapRepository } from "../src/repositories/repoMap.repository.js";
import { createRepoMapService } from "../src/services/repoMap.service.js";

interface Outcome {
  tenantId: string;
  repoFullName: string;
  refreshed: boolean;
  headSha?: string;
  error?: string;
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }

  const tenants = await loadTenants();
  const pool = createDatabasePool(databaseUrl);
  const githubClient = createGithubMcpClient();
  const repoMapRepository = createRepoMapRepository(pool);
  const service = createRepoMapService({ githubClient, repoMapRepository });

  const outcomes: Outcome[] = [];
  try {
    for (const tenant of tenants.all()) {
      for (const repo of tenant.repos) {
        const repoFullName = `${repo.owner}/${repo.name}`;
        try {
          const result = await service.refresh({
            tenant: { tenantId: tenant.tenantId },
            repo: {
              owner: repo.owner,
              name: repo.name,
              defaultBranch: repo.defaultBranch,
              githubToken: repo.githubToken,
            },
          });
          outcomes.push({
            tenantId: tenant.tenantId,
            repoFullName,
            refreshed: result.refreshed,
            headSha: result.headSha,
          });
          const tag = result.refreshed ? "refreshed" : "up-to-date";
          console.log(`${tag}  ${tenant.tenantId}  ${repoFullName}  ${result.headSha}`);
        } catch (error) {
          const msg = (error as Error).message;
          outcomes.push({ tenantId: tenant.tenantId, repoFullName, refreshed: false, error: msg });
          console.error(`error     ${tenant.tenantId}  ${repoFullName}  ${msg}`);
        }
      }
    }
  } finally {
    await pool.close();
  }

  const refreshed = outcomes.filter((o) => o.refreshed).length;
  const failed = outcomes.filter((o) => o.error).length;
  console.log(`done: ${refreshed} refreshed, ${outcomes.length - refreshed - failed} unchanged, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
