import { describe, expect, it } from "vitest";
import type { Tenant } from "../config/tenants.js";
import { ValidationError } from "../shared/errors/index.js";
import { validate } from "./repoScope.service.js";

function makeTenant(overrides: Partial<Tenant> = {}): Tenant {
  const base: Tenant = {
    tenantId: "t",
    displayName: "T",
    repos: [
      { owner: "o", name: "a", githubToken: "x", defaultBranch: "main" },
      { owner: "o", name: "b", githubToken: "y", defaultBranch: "main" },
      { owner: "o", name: "c", githubToken: "z", defaultBranch: "main" },
    ],
    ai: {
      provider: "openai",
      model: "gpt-4o",
      apiKey: "sk",
      dailySpendCapUsd: 1,
    },
    systemPrompt: "s",
    allowedOrigins: [],
    allowedUsers: [],
    rateLimits: { questionsPerMinute: 1, issuesPerHour: 1 },
    ...overrides,
  };
  return base;
}

describe("repoScope.service.validate", () => {
  it("uses request.repoScope when provided", () => {
    const tenant = makeTenant();
    const result = validate({ repoScope: ["o/a"] }, tenant);
    expect(result.allowedRepos.map((r) => `${r.owner}/${r.name}`)).toEqual(["o/a"]);
  });

  it("falls back to tenant.defaultRepoScope when request scope omitted", () => {
    const tenant = makeTenant({ defaultRepoScope: ["o/b"] });
    const result = validate({}, tenant);
    expect(result.allowedRepos.map((r) => `${r.owner}/${r.name}`)).toEqual(["o/b"]);
  });

  it("falls back to tenant.repos when both request scope and default are omitted", () => {
    const tenant = makeTenant();
    const result = validate({}, tenant);
    expect(result.allowedRepos.map((r) => `${r.owner}/${r.name}`)).toEqual(["o/a", "o/b", "o/c"]);
  });

  it("throws ValidationError with generic message (no echo) when entry not in tenant.repos", () => {
    const tenant = makeTenant();
    try {
      validate({ repoScope: ["attacker/secret-repo"] }, tenant);
      expect.fail("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as Error).message).toBe("repo not in tenant scope");
      expect((err as Error).message).not.toContain("attacker");
      expect((err as Error).message).not.toContain("secret-repo");
    }
  });

  it("returns a frozen array", () => {
    const tenant = makeTenant();
    const result = validate({ repoScope: ["o/a"] }, tenant);
    expect(Object.isFrozen(result.allowedRepos)).toBe(true);
  });

  it("empty request.repoScope yields empty allowedRepos (explicit empty scope)", () => {
    const tenant = makeTenant();
    const result = validate({ repoScope: [] }, tenant);
    expect(result.allowedRepos).toEqual([]);
    expect(Object.isFrozen(result.allowedRepos)).toBe(true);
  });
});
