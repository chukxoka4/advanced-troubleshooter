import { describe, expect, it } from "vitest";
import { ChatRequestSchema, ChatResponseSchema } from "./api-contracts.js";

const VALID_UUID = "550e8400-e29b-41d4-a716-446655440000";

describe("ChatRequestSchema", () => {
  it("accepts a valid sessionId + message", () => {
    const parsed = ChatRequestSchema.parse({ sessionId: VALID_UUID, message: "hi" });
    expect(parsed.sessionId).toBe(VALID_UUID);
  });

  it("rejects a non-UUID sessionId", () => {
    expect(() =>
      ChatRequestSchema.parse({ sessionId: "not-a-uuid", message: "hi" }),
    ).toThrow();
  });

  it("rejects an empty message", () => {
    expect(() =>
      ChatRequestSchema.parse({ sessionId: VALID_UUID, message: "" }),
    ).toThrow();
  });

  it("rejects an overlong message (>4000 chars)", () => {
    expect(() =>
      ChatRequestSchema.parse({ sessionId: VALID_UUID, message: "x".repeat(4_001) }),
    ).toThrow();
  });

  it("rejects unknown fields being passed as tenantId (forces header path)", () => {
    // Zod's default is to strip unknown fields, which is the behaviour we want:
    // a client that sends tenantId in the body cannot influence tenant scope.
    const parsed = ChatRequestSchema.parse({
      sessionId: VALID_UUID,
      message: "hi",
      tenantId: "attacker",
    } as unknown as { sessionId: string; message: string });
    expect((parsed as Record<string, unknown>).tenantId).toBeUndefined();
  });
});

describe("ChatResponseSchema", () => {
  it("accepts a well-formed response", () => {
    const parsed = ChatResponseSchema.parse({
      sessionId: VALID_UUID,
      answer: "here you go",
      reposSearched: ["acme/widgets"],
      filesReferenced: [{ repo: "acme/widgets", path: "src/a.ts" }],
    });
    expect(parsed.filesReferenced).toHaveLength(1);
  });

  it("rejects a citation missing path", () => {
    expect(() =>
      ChatResponseSchema.parse({
        sessionId: VALID_UUID,
        answer: "ok",
        reposSearched: [],
        filesReferenced: [{ repo: "acme/widgets" }],
      }),
    ).toThrow();
  });
});
