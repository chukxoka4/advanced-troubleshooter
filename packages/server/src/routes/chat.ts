import type { FastifyInstance } from "fastify";
import { ChatRequestSchema, type ChatResponse } from "@advanced-troubleshooter/shared";
import { ValidationError } from "../shared/errors/index.js";
import type { AiService } from "../services/aiService.js";

/**
 * POST /api/v1/chat
 *
 * Thin route. Parses the body via the shared Zod contract, hands off to
 * aiService.askQuestion, and returns the assistant answer. Auth, tenant
 * resolution, and rate limiting are the middleware's job — this handler
 * assumes req.tenant is present (the tenantResolver middleware guarantees
 * it on every route mounted under the protected scope).
 *
 * Errors from the service bubble to Fastify's registered error handler so
 * one place owns the mapping from domain errors to HTTP.
 */

export interface ChatRouteDeps {
  aiService: AiService;
}

export async function registerChatRoute(
  app: FastifyInstance,
  deps: ChatRouteDeps,
): Promise<void> {
  app.post("/chat", async (req, reply): Promise<ChatResponse> => {
    const tenant = req.tenant;
    if (!tenant) {
      // The tenantResolver middleware should already have thrown; this is
      // defence in depth for misconfigured route scopes.
      throw new ValidationError("tenant context is required");
    }

    const parseResult = ChatRequestSchema.safeParse(req.body);
    if (!parseResult.success) {
      throw new ValidationError(parseResult.error.issues[0]?.message ?? "invalid chat request");
    }
    const { sessionId, message } = parseResult.data;

    const result = await deps.aiService.askQuestion({
      tenant,
      sessionId,
      question: message,
    });

    const body: ChatResponse = {
      sessionId,
      answer: result.answer,
      reposSearched: result.reposSearched,
      filesReferenced: result.filesReferenced.map((f) => {
        const [repo, path] = f.split(/:(.+)/);
        return { repo: repo ?? "", path: path ?? "" };
      }),
    };
    return reply.code(200).send(body);
  });
}
