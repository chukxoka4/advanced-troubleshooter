import { describe, expect, it } from "vitest";
import {
  ChatRequestSchema,
  ChatResponseSchema,
  TenantReposResponseSchema,
} from "./api-contracts.js";

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

  it("accepts optional repoScope with owner/name entries", () => {
    const parsed = ChatRequestSchema.parse({
      sessionId: VALID_UUID,
      message: "hi",
      repoScope: ["acme/widgets", "acme/docs"],
    });
    expect(parsed.repoScope).toEqual(["acme/widgets", "acme/docs"]);
  });

  it("rejects repoScope entries that are not owner/name", () => {
    expect(() =>
      ChatRequestSchema.parse({
        sessionId: VALID_UUID,
        message: "hi",
        repoScope: ["not-valid"],
      }),
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
      reposScoped: ["acme/widgets"],
      reposTouched: ["acme/widgets"],
      filesReferenced: [{ repo: "acme/widgets", path: "src/a.ts", lineStart: 1, lineEnd: 9 }],
    });
    expect(parsed.filesReferenced).toHaveLength(1);
    expect(parsed.filesReferenced[0]?.lineStart).toBe(1);
  });

  it("accepts optional toolCalls", () => {
    const parsed = ChatResponseSchema.parse({
      sessionId: VALID_UUID,
      answer: "ok",
      reposScoped: [],
      reposTouched: [],
      filesReferenced: [],
      toolCalls: [{ name: "readFile", ok: true }, { name: "searchCode", ok: false, errorMessage: "x" }],
    });
    expect(parsed.toolCalls).toHaveLength(2);
  });

  it("rejects a citation missing path", () => {
    expect(() =>
      ChatResponseSchema.parse({
        sessionId: VALID_UUID,
        answer: "ok",
        reposScoped: [],
        reposTouched: [],
        filesReferenced: [{ repo: "acme/widgets" }],
      }),
    ).toThrow();
  });
});

describe("TenantReposResponseSchema", () => {
  it("accepts the tenant repos list shape", () => {
    const parsed = TenantReposResponseSchema.parse({
      repos: [
        { owner: "a", name: "b", fullName: "a/b", isDefault: true },
        { owner: "c", name: "d", fullName: "c/d", isDefault: false },
      ],
    });
    expect(parsed.repos[0]?.isDefault).toBe(true);
  });
});
