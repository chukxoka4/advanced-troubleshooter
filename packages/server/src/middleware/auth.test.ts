import Fastify, { type FastifyInstance } from "fastify";
import { describe, it, expect } from "vitest";
import { registerErrorHandler } from "./errorHandler.js";
import { registerAuth, sharedKeyVerifier, type VerifyApiKey } from "./auth.js";

async function buildApp(verifyApiKey: VerifyApiKey): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  registerErrorHandler(app);
  await registerAuth(app, { verifyApiKey });
  app.get("/protected", async () => ({ ok: true }));
  return app;
}

describe("auth middleware", () => {
  it("rejects requests without an Authorization header with 403", async () => {
    const app = await buildApp(async () => true);
    try {
      const response = await app.inject({ method: "GET", url: "/protected" });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({
        error: "forbidden",
        message: expect.stringMatching(/missing bearer token/),
      });
    } finally {
      await app.close();
    }
  });

  it("rejects a non-Bearer scheme with 403", async () => {
    const app = await buildApp(async () => true);
    try {
      const response = await app.inject({
        method: "GET",
        url: "/protected",
        headers: { authorization: "Basic Zm9vOmJhcg==" },
      });
      expect(response.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });

  it("rejects an invalid key with 403", async () => {
    const app = await buildApp(async () => false);
    try {
      const response = await app.inject({
        method: "GET",
        url: "/protected",
        headers: { authorization: "Bearer nope" },
      });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ error: "forbidden" });
    } finally {
      await app.close();
    }
  });

  it("passes when the verifier returns true", async () => {
    const app = await buildApp(async () => true);
    try {
      const response = await app.inject({
        method: "GET",
        url: "/protected",
        headers: { authorization: "Bearer anything" },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ ok: true });
    } finally {
      await app.close();
    }
  });

  it("calls the verifier with the extracted bearer token", async () => {
    let seen: string | undefined;
    const app = await buildApp(async (key) => {
      seen = key;
      return key === "secret-123";
    });
    try {
      await app.inject({
        method: "GET",
        url: "/protected",
        headers: { authorization: "Bearer secret-123" },
      });
      expect(seen).toBe("secret-123");
    } finally {
      await app.close();
    }
  });
});

describe("sharedKeyVerifier", () => {
  it("returns false when the shared key is undefined", async () => {
    const verify = sharedKeyVerifier(undefined);
    expect(await verify("anything")).toBe(false);
  });

  it("returns true only for the exact matching key", async () => {
    const verify = sharedKeyVerifier("correct-horse-battery-staple");
    expect(await verify("correct-horse-battery-staple")).toBe(true);
    expect(await verify("incorrect")).toBe(false);
    expect(await verify("correct-horse-battery-stapl")).toBe(false);
    expect(await verify("")).toBe(false);
  });

  it("rejects keys of differing length without short-circuiting the crypto path", async () => {
    // Both SHA-256 digests are 32 bytes regardless of input length, so the
    // comparison is constant-time with respect to input-length mismatches.
    // The assertion here is a behavioural one: an input that is much shorter
    // or much longer than the configured key must still return false.
    const verify = sharedKeyVerifier("k".repeat(64));
    expect(await verify("k")).toBe(false);
    expect(await verify("k".repeat(1000))).toBe(false);
    expect(await verify("k".repeat(64))).toBe(true);
  });
});
