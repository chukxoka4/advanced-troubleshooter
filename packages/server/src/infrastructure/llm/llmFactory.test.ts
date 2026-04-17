import { describe, expect, it, vi } from "vitest";
import type { Tenant } from "../../config/tenants.js";
import { createLlmFactory } from "./llmFactory.js";

const BASE_TENANT: Omit<Tenant, "ai" | "tenantId"> = {
  displayName: "X",
  repos: [{ owner: "o", name: "r", githubToken: "t", defaultBranch: "main" }],
  systemPrompt: "sp",
  allowedOrigins: [],
  allowedUsers: [],
  rateLimits: { questionsPerMinute: 1, issuesPerHour: 1 },
};

function tenantWith(provider: "claude" | "openai" | "gemini", tenantId = "team-a"): Tenant {
  return {
    ...BASE_TENANT,
    tenantId,
    ai: { provider, model: "m", apiKey: "k", dailySpendCapUsd: 10 },
  };
}

describe("llmFactory", () => {
  const fetchImpl = vi.fn() as unknown as typeof fetch;

  it("returns claude provider for provider=claude", () => {
    const factory = createLlmFactory({ fetchImpl });
    const p = factory.getProvider(tenantWith("claude"));
    expect(p.name).toBe("claude");
  });

  it("returns openai provider for provider=openai", () => {
    const factory = createLlmFactory({ fetchImpl });
    expect(factory.getProvider(tenantWith("openai")).name).toBe("openai");
  });

  it("returns gemini provider for provider=gemini", () => {
    const factory = createLlmFactory({ fetchImpl });
    expect(factory.getProvider(tenantWith("gemini")).name).toBe("gemini");
  });

  it("throws on an unknown provider value", () => {
    const factory = createLlmFactory({ fetchImpl });
    const tenant = { ...tenantWith("claude") } as Tenant;
    (tenant.ai as unknown as { provider: string }).provider = "mistral";
    expect(() => factory.getProvider(tenant)).toThrow(/unknown provider/);
  });

  it("memoises per tenantId so spend tracking accumulates", () => {
    const factory = createLlmFactory({ fetchImpl });
    const a = factory.getProvider(tenantWith("claude", "team-a"));
    const again = factory.getProvider(tenantWith("claude", "team-a"));
    const b = factory.getProvider(tenantWith("claude", "team-b"));
    expect(a).toBe(again);
    expect(a).not.toBe(b);
  });
});
