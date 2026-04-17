import Fastify from "fastify";
import { appMode, isPrototype } from "./config/appMode.js";
import { loadTenants } from "./config/tenants.js";
import { initErrorTracker } from "./infrastructure/errorTracker.js";
import { rootLogger } from "./infrastructure/logger.js";
import { sharedKeyVerifier, type VerifyApiKey } from "./middleware/auth.js";
import {
  registerGlobalErrorHandler,
  registerProtectedMiddleware,
} from "./middleware/register.js";

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "0.0.0.0";

function resolveVerifyApiKey(): VerifyApiKey {
  if (isPrototype()) {
    return sharedKeyVerifier(process.env.SHARED_API_KEY);
  }
  return async () => {
    throw new Error(
      "production API key verification is not yet wired — see commit 24 (apiKeyService)",
    );
  };
}

async function main(): Promise<void> {
  initErrorTracker();

  const tenants = await loadTenants();
  const verifyApiKey = resolveVerifyApiKey();

  const app = Fastify({ logger: true });
  registerGlobalErrorHandler(app);

  await app.register(
    async (protectedScope) => {
      await registerProtectedMiddleware(protectedScope, { tenants, verifyApiKey });
    },
    { prefix: "/api/v1" },
  );

  try {
    await app.listen({ port: PORT, host: HOST });
    rootLogger.info({ appMode, port: PORT, host: HOST }, "server listening");
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
}

void main();
