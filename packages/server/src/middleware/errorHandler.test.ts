import Fastify from "fastify";
import { describe, it, expect } from "vitest";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  RateLimitError,
  ValidationError,
} from "../shared/errors/index.js";
import { registerErrorHandler } from "./errorHandler.js";

describe("errorHandler middleware", () => {
  const domainCases = [
    { Cls: NotFoundError, status: 404, code: "not_found" },
    { Cls: ValidationError, status: 400, code: "validation_error" },
    { Cls: ForbiddenError, status: 403, code: "forbidden" },
    { Cls: ConflictError, status: 409, code: "conflict" },
    { Cls: RateLimitError, status: 429, code: "rate_limited" },
  ] as const;

  for (const { Cls, status, code } of domainCases) {
    it(`maps ${Cls.name} to HTTP ${status} with code "${code}"`, async () => {
      const app = Fastify();
      registerErrorHandler(app);
      app.get("/", async () => {
        throw new Cls("specific thing went wrong");
      });
      try {
        const response = await app.inject({ method: "GET", url: "/" });
        expect(response.statusCode).toBe(status);
        expect(response.json()).toEqual({
          error: code,
          message: "specific thing went wrong",
        });
      } finally {
        await app.close();
      }
    });
  }

  it("maps Fastify schema-validation errors to 400 validation_error with a generic message", async () => {
    const app = Fastify({ logger: false });
    registerErrorHandler(app);
    app.post(
      "/",
      {
        schema: {
          body: {
            type: "object",
            required: ["internalFieldName"],
            properties: { internalFieldName: { type: "string" } },
          },
        },
      },
      async () => ({ ok: true }),
    );
    try {
      const response = await app.inject({
        method: "POST",
        url: "/",
        payload: {},
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        error: "validation_error",
        message: "Request payload failed validation.",
      });
      // The internal field name must NOT leak to the client via error.message.
      expect(response.body).not.toContain("internalFieldName");
    } finally {
      await app.close();
    }
  });

  it("maps unknown errors to 500 with a generic message and does not leak details", async () => {
    const app = Fastify({ logger: false });
    registerErrorHandler(app);
    app.get("/", async () => {
      throw new Error("internal database credential: hunter2");
    });
    try {
      const response = await app.inject({ method: "GET", url: "/" });
      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual({
        error: "internal_error",
        message: "Something went wrong.",
      });
      expect(response.body).not.toContain("hunter2");
    } finally {
      await app.close();
    }
  });
});
