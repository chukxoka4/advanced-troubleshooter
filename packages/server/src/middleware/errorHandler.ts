import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { captureException } from "../infrastructure/errorTracker.js";
import { isDomainError } from "../shared/errors/index.js";

/**
 * Global error handler. The last piece of the middleware chain — Fastify
 * calls it for any error thrown by a hook, handler, or validator.
 *
 * Domain errors → their declared statusCode + structured body.
 * Fastify validation errors → 400 (they already carry FastifyError shape).
 * Anything else → 500 + Sentry capture + a deliberately generic message so
 * internal details never leak to the client.
 */

interface ErrorResponse {
  error: string;
  message: string;
}

function isFastifyValidationError(error: unknown): error is FastifyError {
  return (
    typeof error === "object" &&
    error !== null &&
    "validation" in error &&
    Array.isArray((error as { validation?: unknown }).validation)
  );
}

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler(async (error: unknown, req: FastifyRequest, reply: FastifyReply) => {
    if (isDomainError(error)) {
      const body: ErrorResponse = { error: error.code, message: error.message };
      return reply.code(error.statusCode).send(body);
    }

    if (isFastifyValidationError(error)) {
      const body: ErrorResponse = {
        error: "validation_error",
        message: error.message,
      };
      return reply.code(400).send(body);
    }

    req.log.error({ err: error }, "unhandled error");
    captureException(error, {
      url: req.url,
      method: req.method,
      tenant_id: req.tenant?.tenantId,
    });

    const body: ErrorResponse = {
      error: "internal_error",
      message: "Something went wrong.",
    };
    return reply.code(500).send(body);
  });
}
