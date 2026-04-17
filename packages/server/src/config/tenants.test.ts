import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { NotFoundError, ValidationError } from "../shared/errors/index.js";
import { loadTenants } from "./tenants.js";

const BASE_TENANT = {
  tenantId: "team-alpha",
  displayName: "Team Alpha",
  repos: [
    {
      owner: "acme",
      name: "widget",
      description: "The widget repo",
      githubToken: "${TEAM_ALPHA_GH_TOKEN}",
      defaultBranch: "main",
    },
  ],
  ai: {
    provider: "openai" as const,
    model: "gpt-4o",
    apiKey: "${TEAM_ALPHA_LLM_API_KEY}",
    dailySpendCapUsd: 10,
  },
  systemPrompt: "You are a support assistant.",
  rateLimits: {
    questionsPerMinute: 10,
    issuesPerHour: 20,
  },
};

describe("loadTenants", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "tenants-test-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function writeTenant(file: string, json: unknown): Promise<void> {
    await writeFile(join(dir, file), JSON.stringify(json, null, 2));
  }

  it("resolves ${ENV_VAR} placeholders to process.env values", async () => {
    await writeTenant("team-alpha.json", BASE_TENANT);

    const loaded = await loadTenants({
      dir,
      env: {
        TEAM_ALPHA_GH_TOKEN: "resolved-gh-token",
        TEAM_ALPHA_LLM_API_KEY: "resolved-llm-key",
      },
    });

    const tenant = loaded.getTenant("team-alpha");
    expect(tenant.repos[0]?.githubToken).toBe("resolved-gh-token");
    expect(tenant.ai.apiKey).toBe("resolved-llm-key");
  });

  it("skips files whose names start with underscore (templates)", async () => {
    await writeTenant("_template.json", {
      ...BASE_TENANT,
      tenantId: "team-template",
    });

    const loaded = await loadTenants({ dir, env: {} });
    expect(loaded.allTenantIds()).toEqual([]);
  });

  it("throws ValidationError when a referenced env var is missing", async () => {
    await writeTenant("team-alpha.json", BASE_TENANT);

    await expect(
      loadTenants({ dir, env: { TEAM_ALPHA_LLM_API_KEY: "resolved" } }),
    ).rejects.toThrow(ValidationError);
    await expect(
      loadTenants({ dir, env: { TEAM_ALPHA_LLM_API_KEY: "resolved" } }),
    ).rejects.toThrow(/TEAM_ALPHA_GH_TOKEN/);
  });

  it("throws ValidationError when a raw GitHub PAT appears in the JSON", async () => {
    await writeTenant("team-alpha.json", {
      ...BASE_TENANT,
      repos: [
        {
          ...BASE_TENANT.repos[0],
          githubToken: "ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789",
        },
      ],
    });

    await expect(loadTenants({ dir, env: {} })).rejects.toThrow(ValidationError);
    await expect(loadTenants({ dir, env: {} })).rejects.toThrow(/raw secret/);
  });

  it("throws ValidationError when a raw fine-grained PAT appears", async () => {
    await writeTenant("team-alpha.json", {
      ...BASE_TENANT,
      repos: [
        {
          ...BASE_TENANT.repos[0],
          githubToken: "github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuv",
        },
      ],
    });

    await expect(loadTenants({ dir, env: {} })).rejects.toThrow(ValidationError);
    await expect(loadTenants({ dir, env: {} })).rejects.toThrow(/github_pat_/);
  });

  it("throws ValidationError when a required field is missing", async () => {
    const bad = { ...BASE_TENANT } as Record<string, unknown>;
    delete bad.systemPrompt;
    await writeTenant("team-alpha.json", bad);

    await expect(
      loadTenants({
        dir,
        env: {
          TEAM_ALPHA_GH_TOKEN: "x",
          TEAM_ALPHA_LLM_API_KEY: "y",
        },
      }),
    ).rejects.toThrow(ValidationError);
  });

  it("throws ValidationError when two files share a tenantId", async () => {
    await writeTenant("team-alpha.json", BASE_TENANT);
    await writeTenant("team-alpha-copy.json", BASE_TENANT);

    await expect(
      loadTenants({
        dir,
        env: {
          TEAM_ALPHA_GH_TOKEN: "x",
          TEAM_ALPHA_LLM_API_KEY: "y",
        },
      }),
    ).rejects.toThrow(/duplicate tenantId/);
  });

  it("throws ValidationError on invalid JSON", async () => {
    await writeFile(join(dir, "broken.json"), "{ not json");
    await expect(loadTenants({ dir, env: {} })).rejects.toThrow(/not valid JSON/);
  });

  it("getTenant throws NotFoundError for unknown tenant", async () => {
    await writeTenant("team-alpha.json", BASE_TENANT);
    const loaded = await loadTenants({
      dir,
      env: {
        TEAM_ALPHA_GH_TOKEN: "x",
        TEAM_ALPHA_LLM_API_KEY: "y",
      },
    });
    expect(() => loaded.getTenant("team-nope")).toThrow(NotFoundError);
  });

  it("rejects tenantId that is not kebab-case", async () => {
    await writeTenant("bad.json", { ...BASE_TENANT, tenantId: "TeamAlpha" });
    await expect(
      loadTenants({
        dir,
        env: {
          TEAM_ALPHA_GH_TOKEN: "x",
          TEAM_ALPHA_LLM_API_KEY: "y",
        },
      }),
    ).rejects.toThrow(ValidationError);
  });
});
