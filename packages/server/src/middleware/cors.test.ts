import Fastify from "fastify";
import { describe, it, expect } from "vitest";
import { registerCors } from "./cors.js";

async function buildApp(options: Parameters<typeof registerCors>[1]) {
  const app = Fastify();
  await registerCors(app, options);
  app.get("/ping", async () => ({ ok: true }));
  return app;
}

describe("cors middleware", () => {
  it("reflects any origin when allowedOrigins is null (prototype)", async () => {
    const app = await buildApp({ allowedOrigins: null });
    try {
      const response = await app.inject({
        method: "GET",
        url: "/ping",
        headers: { origin: "https://random-origin.example" },
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers["access-control-allow-origin"]).toBe("https://random-origin.example");
    } finally {
      await app.close();
    }
  });

  it("accepts a request from an allowed origin in strict mode", async () => {
    const app = await buildApp({
      allowedOrigins: new Set(["https://allowed.example"]),
    });
    try {
      const response = await app.inject({
        method: "GET",
        url: "/ping",
        headers: { origin: "https://allowed.example" },
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers["access-control-allow-origin"]).toBe("https://allowed.example");
    } finally {
      await app.close();
    }
  });

  it("omits the allow-origin header for a disallowed origin in strict mode", async () => {
    const app = await buildApp({
      allowedOrigins: new Set(["https://allowed.example"]),
    });
    try {
      const response = await app.inject({
        method: "GET",
        url: "/ping",
        headers: { origin: "https://evil.example" },
      });
      expect(response.headers["access-control-allow-origin"]).toBeUndefined();
    } finally {
      await app.close();
    }
  });
});
