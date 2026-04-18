import { describe, expect, it, vi } from "vitest";
import type { GithubMcpClient } from "../../infrastructure/githubClient.js";
import type { RepoMapRepository, RepoMapRow } from "../../repositories/repoMap.repository.js";
import { ValidationError } from "../../shared/errors/index.js";
import type { TenantRepo } from "../repoScope.service.js";
import { findSymbolTool } from "./findSymbol.tool.js";
import type { ToolContext } from "./types.js";

const silentLogger: ToolContext["logger"] = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

function makeRepo(owner: string, name: string): TenantRepo {
  return { owner, name, githubToken: "t", defaultBranch: "main" };
}

function mapRow(repoFullName: string, content: string): RepoMapRow {
  return {
    id: "1",
    tenantId: "t",
    repoFullName,
    defaultBranch: "main",
    headSha: "s",
    content,
    symbolCount: 1,
    builtAt: new Date(),
  };
}

const SAMPLE_A = [
  "## acme/a (branch: main)",
  "",
  "### src/repoScope.service.ts",
  "- L10-20 function validate: function validate(req, tenant)",
  "- L25-30 class RepoScopeError: class RepoScopeError",
].join("\n");

const SAMPLE_B = [
  "## acme/b (branch: main)",
  "",
  "### src/other.ts",
  "- L1-5 function otherThing: function otherThing()",
].join("\n");

function makeCtx(
  allowed: TenantRepo[],
  maps: Record<string, RepoMapRow>,
): { ctx: ToolContext; getMap: ReturnType<typeof vi.fn> } {
  const getMap = vi.fn(async (_tenantId: string, repoFullName: string) => maps[repoFullName] ?? null);
  const repo = {
    getMap,
    upsertMap: vi.fn(),
    listMapsForTenant: vi.fn(),
  } as unknown as RepoMapRepository;
  const ctx: ToolContext = {
    tenant: { tenantId: "t" } as ToolContext["tenant"],
    allowedRepos: allowed,
    githubClient: {} as GithubMcpClient,
    repoMapRepository: repo,
    logger: silentLogger,
  };
  return { ctx, getMap };
}

describe("findSymbolTool", () => {
  it("only scans allowed repos", async () => {
    const { ctx, getMap } = makeCtx([makeRepo("acme", "a")], {
      "acme/a": mapRow("acme/a", SAMPLE_A),
      "acme/b": mapRow("acme/b", SAMPLE_B),
    });
    const out = await findSymbolTool.execute({ symbol: "otherThing" }, ctx);
    // the map exists for acme/b but we never looked it up
    expect(getMap.mock.calls.map((c) => c[1])).toEqual(["acme/a"]);
    expect(out).toBe("no matches");
  });

  it("returns matches with repo, path, and line range", async () => {
    const { ctx } = makeCtx([makeRepo("acme", "a")], {
      "acme/a": mapRow("acme/a", SAMPLE_A),
    });
    const out = await findSymbolTool.execute({ symbol: "validate" }, ctx);
    expect(out).toContain("acme/a:src/repoScope.service.ts");
    expect(out).toContain("L10-20");
    expect(out).toContain("validate");
  });

  it("unknown symbol returns 'no matches' (not an error)", async () => {
    const { ctx } = makeCtx([makeRepo("acme", "a")], {
      "acme/a": mapRow("acme/a", SAMPLE_A),
    });
    const out = await findSymbolTool.execute({ symbol: "zzzDoesNotExist" }, ctx);
    expect(out).toBe("no matches");
  });

  it("rejects out-of-scope repo arg", async () => {
    const { ctx, getMap } = makeCtx([makeRepo("acme", "a")], {});
    await expect(
      findSymbolTool.execute({ symbol: "x", repo: "attacker/x" }, ctx),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(getMap).not.toHaveBeenCalled();
  });
});
