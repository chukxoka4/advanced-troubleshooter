import { describe, expect, it, vi } from "vitest";
import type { ApiKeyRepository, ApiKeyRow } from "../repositories/apiKey.repository.js";
import { createApiKeyService } from "./apiKeyService.js";

function makeRow(overrides: Partial<ApiKeyRow> = {}): ApiKeyRow {
  return {
    id: "row-1",
    tenantId: "team-alpha",
    label: null,
    createdAt: new Date(),
    revokedAt: null,
    ...overrides,
  };
}

function makeRepo() {
  const stored: { tenantId: string; keyHash: string; label?: string }[] = [];
  const repo: ApiKeyRepository = {
    storeKeyHash: vi.fn(async (input) => {
      stored.push(input);
      return makeRow({ tenantId: input.tenantId, label: input.label ?? null });
    }),
    findByKeyHash: vi.fn(async (hash) => {
      const match = stored.find((s) => s.keyHash === hash);
      return match ? makeRow({ tenantId: match.tenantId }) : null;
    }),
    revoke: vi.fn(async () => undefined),
  };
  return { repo, stored };
}

describe("apiKeyService", () => {
  it("generate returns plaintext once and stores only the hash", async () => {
    const { repo, stored } = makeRepo();
    const service = createApiKeyService({ repository: repo });
    const { plaintext, row } = await service.generate({ tenantId: "team-alpha", label: "prod" });
    expect(plaintext).toMatch(/^ats_[A-Za-z0-9_-]{20,}$/);
    expect(row.tenantId).toBe("team-alpha");
    expect(stored).toHaveLength(1);
    expect(stored[0]?.keyHash).not.toBe(plaintext);
    expect(stored[0]?.keyHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("verify round-trips a freshly generated key", async () => {
    const { repo } = makeRepo();
    const service = createApiKeyService({ repository: repo });
    const { plaintext } = await service.generate({ tenantId: "team-alpha" });
    const verified = await service.verify(plaintext);
    expect(verified?.tenantId).toBe("team-alpha");
  });

  it("verify returns null for unknown or malformed keys", async () => {
    const { repo } = makeRepo();
    const service = createApiKeyService({ repository: repo });
    expect(await service.verify("")).toBeNull();
    expect(await service.verify("not-an-api-key")).toBeNull();
    expect(await service.verify("ats_unknown")).toBeNull();
  });

  it("never returns plaintext from the repository path", async () => {
    const { repo, stored } = makeRepo();
    const service = createApiKeyService({ repository: repo });
    const { plaintext } = await service.generate({ tenantId: "t" });
    const storedValue = stored[0]?.keyHash ?? "";
    expect(storedValue).not.toContain(plaintext);
    const verified = await service.verify(plaintext);
    expect(JSON.stringify(verified)).not.toContain(plaintext);
  });

  it("generate requires a tenantId", async () => {
    const { repo } = makeRepo();
    const service = createApiKeyService({ repository: repo });
    await expect(service.generate({ tenantId: "" })).rejects.toThrow(/tenantId is required/);
  });
});
