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
import { createGithubMcpClient } from "./infrastructure/githubMcp.js";
import { createLlmFactory } from "./infrastructure/llm/llmFactory.js";
import { createAnalyticsRepository } from "./repositories/analytics.repository.js";
import { createApiKeyRepository } from "./repositories/apiKey.repository.js";
import { createConversationRepository } from "./repositories/conversation.repository.js";
import { createAiService } from "./services/aiService.js";
import { createApiKeyService } from "./services/apiKeyService.js";
import { registerChatRoute } from "./routes/chat.js";
import { registerHealthRoutes } from "./routes/health.js";

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
  const apiKeyService = createApiKeyService({ repository: apiKeyRepo });
  const githubMcp = createGithubMcpClient();
  const llmFactory = createLlmFactory();
  const aiService = createAiService({
    conversationRepo,
    analyticsRepo,
    githubMcp,
    llmFactory,
  });
  const verifyApiKey = resolveVerifyApiKey(apiKeyService);
  const startedAt = Date.now();

  const app = Fastify({ logger: true });
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
