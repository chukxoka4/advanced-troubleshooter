import { describe, expect, it, vi } from "vitest";
import type { Tenant } from "../../config/tenants.js";
import type { IssueCreator } from "../../infrastructure/issueCreator.js";
import { RateLimitError } from "../../shared/errors/index.js";
import { buildDefaultAgentTools, tenantHasIssueSearchTarget } from "../defaultAgentTools.js";
import { createIssueCreateRateGate } from "../issueCreateRateGate.service.js";
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

function makeCtx(
  tenant: Tenant,
  allowed: TenantRepo[],
  issueCreateRateGate: ToolContext["issueCreateRateGate"] = { tryConsume: vi.fn() },
): ToolContext {
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
    ...(issueCreateRateGate !== undefined ? { issueCreateRateGate } : {}),
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

  it("applies issueCreateRateGate before issueCreator (issuesPerHour)", async () => {
    const t0 = Date.UTC(2026, 2, 10, 8, 0, 0);
    const now = vi.fn(() => t0);
    const gate = createIssueCreateRateGate({ now });
    const create = vi.fn(async () => ({ url: "https://gh/issue/1", number: 1 }));
    const tool = createCreateIssueTool({ create });
    const tenant = makeTenant({ rateLimits: { questionsPerMinute: 1, issuesPerHour: 1 } });
    const ctx = makeCtx(tenant, [makeRepo()], gate);
    await tool.execute({ repo: "acme/widgets", title: "a", body: "b" }, ctx);
    await expect(tool.execute({ repo: "acme/widgets", title: "c", body: "d" }, ctx)).rejects.toBeInstanceOf(
      RateLimitError,
    );
    expect(create).toHaveBeenCalledTimes(1);
  });
});

describe("buildDefaultAgentTools issue registration", () => {
  const noopCreator: IssueCreator = { create: vi.fn() };

  it("omits issue tools when there is no issue target on the tenant", () => {
    const names = buildDefaultAgentTools(
      makeTenant({ issueConfig: undefined, repos: [makeRepo()] }),
      noopCreator,
    ).map((t) => t.name);
    expect(names).not.toContain("createIssue");
    expect(names).not.toContain("searchIssues");
  });

  it("includes searchIssues when targetRepo maps to a repo but writeToken is absent", () => {
    const names = buildDefaultAgentTools(
      makeTenant({ issueConfig: { targetRepo: "acme/widgets" } }),
      noopCreator,
    ).map((t) => t.name);
    expect(names).toContain("searchIssues");
    expect(names).not.toContain("createIssue");
  });

  it("includes createIssue when writeToken is present", () => {
    const names = buildDefaultAgentTools(makeTenant(), noopCreator).map((t) => t.name);
    expect(names).toContain("createIssue");
    expect(names).toContain("searchIssues");
  });
});

describe("tenantHasIssueSearchTarget", () => {
  it("is false when target repo is not declared on the tenant", () => {
    expect(
      tenantHasIssueSearchTarget(
        makeTenant({
          repos: [makeRepo("other", "repo")],
          issueConfig: { targetRepo: "acme/widgets" },
        }),
      ),
    ).toBe(false);
  });
});
