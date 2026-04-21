import Fastify from "fastify";
import { appMode, isPrototype } from "./config/appMode.js";
import { loadTenants } from "./config/tenants.js";
import { loadBuildInfo } from "./infrastructure/buildInfo.js";
import { createDatabasePool } from "./infrastructure/db.js";
import { initErrorTracker } from "./infrastructure/errorTracker.js";
import { rootLogger } from "./infrastructure/logger.js";
import { sharedKeyVerifier, type VerifyApiKey } from "./middleware/auth.js";
import {
  registerGlobalErrorHandler,
  registerProtectedMiddleware,
} from "./middleware/register.js";
import { createGithubMcpClient } from "./infrastructure/githubClient.js";
import { createIssueCreator } from "./infrastructure/issueCreator.js";
import { createLlmFactory } from "./infrastructure/llm/llmFactory.js";
import { createAnalyticsRepository } from "./repositories/analytics.repository.js";
import { createApiKeyRepository } from "./repositories/apiKey.repository.js";
import { createConversationRepository } from "./repositories/conversation.repository.js";
import { createRepoMapRepository } from "./repositories/repoMap.repository.js";
import { registerChatRoute } from "./routes/chat.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerTenantReposRoute } from "./routes/tenantRepos.js";
import { createAiService } from "./services/aiService.js";
import { createApiKeyService } from "./services/apiKeyService.js";
import { createRepoMapService } from "./services/repoMap.service.js";

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "0.0.0.0";

function resolveVerifyApiKey(
  apiKeyService: ReturnType<typeof createApiKeyService>,
): VerifyApiKey {
  if (isPrototype()) return sharedKeyVerifier(process.env.SHARED_API_KEY);
  return async (presented: string): Promise<boolean> => {
    const row = await apiKeyService.verify(presented);
    return row !== null;
  };
}

function requireDatabaseUrl(): string {
  const value = process.env.DATABASE_URL;
  if (!value) throw new Error("DATABASE_URL is required");
  return value;
}

async function main(): Promise<void> {
  initErrorTracker();

  const [tenants, buildInfo] = await Promise.all([loadTenants(), loadBuildInfo()]);
  const db = createDatabasePool(requireDatabaseUrl());
  const conversationRepo = createConversationRepository(db);
  const analyticsRepo = createAnalyticsRepository(db);
  const apiKeyRepo = createApiKeyRepository(db);
  const pepper = process.env.API_KEY_PEPPER;
  if (!isPrototype() && (!pepper || pepper.length < 32)) {
    throw new Error("API_KEY_PEPPER (>=32 chars) is required in production");
  }
  const apiKeyService = createApiKeyService({
    repository: apiKeyRepo,
    pepper: pepper ?? "prototype-only-pepper-not-for-production-use",
  });
  const githubMcp = createGithubMcpClient();
  const llmFactory = createLlmFactory();
  const repoMapRepository = createRepoMapRepository(db);
  const repoMapService = createRepoMapService({
    githubClient: githubMcp,
    repoMapRepository,
  });
  const issueCreator = createIssueCreator();
  const aiService = createAiService({
    conversationRepo,
    analyticsRepo,
    githubClient: githubMcp,
    llmFactory,
    repoMapService,
    repoMapRepository,
    issueCreator,
  });
  const verifyApiKey = resolveVerifyApiKey(apiKeyService);
  const startedAt = Date.now();

  const app = Fastify({
    logger: {
      // Defence in depth: tenant objects carry provider keys and GitHub
      // tokens. No current call site logs them, but redacting at the
      // logger level means a future `req.log.info({ tenant })` cannot
      // leak secrets in structured logs.
      redact: {
        paths: [
          "tenant.ai.apiKey",
          "*.ai.apiKey",
          "tenant.repos[*].githubToken",
          "tenant.issueConfig.writeToken",
          "*.repos[*].githubToken",
          "*.issueConfig.writeToken",
          "*.apiKey",
          "*.githubToken",
          "authorization",
          "*.authorization",
          'headers["authorization"]',
          'headers["x-api-key"]',
        ],
        censor: "[redacted]",
      },
    },
  });
  registerGlobalErrorHandler(app);

  await app.register(
    async (publicScope) => {
      await registerHealthRoutes(publicScope, {
        db,
        appMode,
        version: buildInfo.version,
        gitSha: buildInfo.gitSha,
        startedAt,
      });
    },
    { prefix: "/api/v1" },
  );

  await app.register(
    async (protectedScope) => {
      await registerProtectedMiddleware(protectedScope, { tenants, verifyApiKey });
      await registerChatRoute(protectedScope, { aiService });
      await registerTenantReposRoute(protectedScope);
    },
    { prefix: "/api/v1" },
  );

  app.addHook("onClose", async () => {
    await db.close();
  });

  try {
    await app.listen({ port: PORT, host: HOST });
    rootLogger.info(
      { appMode, port: PORT, host: HOST, version: buildInfo.version, gitSha: buildInfo.gitSha },
      "server listening",
    );
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
}

void main();
