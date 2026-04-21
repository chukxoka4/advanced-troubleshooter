import { describe, expect, it, vi } from "vitest";
import type { Tenant } from "../../config/tenants.js";
import type { IssueCreator } from "../../infrastructure/issueCreator.js";
import { buildDefaultAgentTools } from "../defaultAgentTools.js";
import type { TenantRepo } from "../repoScope.service.js";
import type { ToolContext } from "./types.js";
import { createCreateIssueTool } from "./createIssue.tool.js";

const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

function makeRepo(owner = "acme", name = "widgets"): TenantRepo {
  return { owner, name, githubToken: "read", defaultBranch: "main" };
}

function makeTenant(overrides: Partial<Tenant> = {}): Tenant {
  return {
    tenantId: "t",
    displayName: "T",
    repos: [makeRepo()],
    issueConfig: { targetRepo: "acme/widgets", writeToken: "write" },
    ai: { provider: "openai", model: "gpt-4o", apiKey: "sk", dailySpendCapUsd: 10 },
    systemPrompt: "s",
    allowedOrigins: [],
    allowedUsers: [],
    rateLimits: { questionsPerMinute: 1, issuesPerHour: 1 },
    ...overrides,
  } as Tenant;
}

function makeCtx(tenant: Tenant, allowed: TenantRepo[]): ToolContext {
  return {
    tenant,
    allowedRepos: allowed,
    githubClient: {
      searchFiles: vi.fn(),
      searchIssues: vi.fn(),
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

describe("createCreateIssueTool", () => {
  it("calls issueCreator with the write token when repo matches targetRepo", async () => {
    const create = vi.fn(async () => ({ url: "https://gh/issue/1", number: 1 }));
    const issueCreator: IssueCreator = { create };
    const tool = createCreateIssueTool(issueCreator);
    const tenant = makeTenant();
    const out = await tool.execute(
      { repo: "acme/widgets", title: " T ", body: "b" },
      makeCtx(tenant, [makeRepo()]),
    );
    expect(JSON.parse(out)).toEqual({ url: "https://gh/issue/1", number: 1 });
    expect(create).toHaveBeenCalledWith("acme/widgets", { title: "T", body: "b" }, "write");
  });

  it("rejects wrong repo with generic scope message", async () => {
    const tool = createCreateIssueTool({ create: vi.fn() });
    await expect(
      tool.execute(
        { repo: "evil/other", title: "x", body: "y" },
        makeCtx(makeTenant(), [makeRepo()]),
      ),
    ).rejects.toMatchObject({ message: "repo not in tenant scope" });
  });
});

describe("buildDefaultAgentTools issue registration", () => {
  const noopCreator: IssueCreator = { create: vi.fn() };

  it("omits issue tools when writeToken is absent", () => {
    const names = buildDefaultAgentTools(
      makeTenant({ issueConfig: { targetRepo: "acme/widgets" } }),
      noopCreator,
    ).map((t) => t.name);
    expect(names).not.toContain("createIssue");
    expect(names).not.toContain("searchIssues");
  });

  it("includes issue tools when writeToken is present", () => {
    const names = buildDefaultAgentTools(makeTenant(), noopCreator).map((t) => t.name);
    expect(names).toContain("createIssue");
    expect(names).toContain("searchIssues");
  });
});
