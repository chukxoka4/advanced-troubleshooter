import { describe, expect, it, vi } from "vitest";
import type { Tenant } from "../../config/tenants.js";
import { ValidationError } from "../../shared/errors/index.js";
import type { TenantRepo } from "../repoScope.service.js";
import type { ToolContext } from "./types.js";
import { searchIssuesTool } from "./searchIssues.tool.js";

const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

function makeRepo(owner = "acme", name = "widgets"): TenantRepo {
  return { owner, name, githubToken: "readtok", defaultBranch: "main" };
}

function makeTenant(): Tenant {
  return {
    tenantId: "t",
    displayName: "T",
    repos: [makeRepo()],
    issueConfig: { targetRepo: "acme/widgets" },
    ai: { provider: "openai", model: "gpt-4o", apiKey: "sk", dailySpendCapUsd: 10 },
    systemPrompt: "s",
    allowedOrigins: [],
    allowedUsers: [],
    rateLimits: { questionsPerMinute: 1, issuesPerHour: 1 },
  } as Tenant;
}

function makeCtx(tenant: Tenant, searchIssues: ReturnType<typeof vi.fn>): ToolContext {
  return {
    tenant,
    allowedRepos: [makeRepo()],
    githubClient: {
      searchFiles: vi.fn(),
      searchIssues,
      readFile: vi.fn(),
      getRepo: vi.fn(),
      listDir: vi.fn(),
      getCommitSha: vi.fn(),
      readFileRange: vi.fn(),
    },
    repoMapRepository: {} as ToolContext["repoMapRepository"],
    logger: silentLogger,
  };
}

describe("searchIssuesTool", () => {
  it("calls githubClient.searchIssues with the read token for the target repo", async () => {
    const searchIssues = vi.fn(async () => [{ title: "Bug", url: "https://github.com/acme/widgets/issues/3" }]);
    const out = await searchIssuesTool.execute(
      { repo: "acme/widgets", query: "timeout" },
      makeCtx(makeTenant(), searchIssues),
    );
    expect(out).toContain("Bug");
    expect(out).toContain("issues/3");
    expect(searchIssues).toHaveBeenCalledWith("acme/widgets", "timeout", "readtok", { limit: undefined });
  });

  it("rejects repo mismatch before any network call", async () => {
    const searchIssues = vi.fn();
    await expect(
      searchIssuesTool.execute(
        { repo: "other/repo", query: "x" },
        makeCtx(makeTenant(), searchIssues),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(searchIssues).not.toHaveBeenCalled();
  });
});
