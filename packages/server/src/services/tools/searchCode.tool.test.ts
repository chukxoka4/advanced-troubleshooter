import { describe, expect, it, vi } from "vitest";
import type { GithubMcpClient } from "../../infrastructure/githubClient.js";
import type { RepoMapRepository } from "../../repositories/repoMap.repository.js";
import { ValidationError } from "../../shared/errors/index.js";
import type { TenantRepo } from "../repoScope.service.js";
import { searchCodeTool } from "./searchCode.tool.js";
import type { ToolContext } from "./types.js";

const silentLogger: ToolContext["logger"] = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

function makeRepo(owner: string, name: string): TenantRepo {
  return { owner, name, githubToken: `tok-${name}`, defaultBranch: "main" };
}

function makeCtx(allowedRepos: TenantRepo[], client: GithubMcpClient): ToolContext {
  return {
    tenant: {} as ToolContext["tenant"],
    allowedRepos,
    githubClient: client,
    repoMapRepository: {} as RepoMapRepository,
    logger: silentLogger,
  };
}

describe("searchCodeTool", () => {
  it("rejects explicit repo arg not in allowed scope, no network call", async () => {
    const searchFiles = vi.fn();
    const ctx = makeCtx(
      [makeRepo("acme", "widgets")],
      { searchFiles } as unknown as GithubMcpClient,
    );
    await expect(
      searchCodeTool.execute({ query: "foo", repo: "attacker/x" }, ctx),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(searchFiles).not.toHaveBeenCalled();
  });

  it("multi-repo scoped search: one call per allowed repo, zero for others", async () => {
    const searchFiles = vi.fn(async (_q, repo) => [
      { repo: `${repo.owner}/${repo.name}`, path: "x.ts", url: "https://g/x" },
    ]);
    const allowed = [makeRepo("acme", "a"), makeRepo("acme", "b")];
    const ctx = makeCtx(allowed, { searchFiles } as unknown as GithubMcpClient);
    const out = await searchCodeTool.execute({ query: "foo" }, ctx);
    expect(searchFiles).toHaveBeenCalledTimes(2);
    const calledRepoTokens = searchFiles.mock.calls.map(
      (c) => (c as unknown as [string, unknown, string])[2],
    );
    expect(calledRepoTokens).toEqual(["tok-a", "tok-b"]);
    // never call with a token for a non-allowed repo
    expect(calledRepoTokens).not.toContain("tok-c");
    expect(out).toContain("acme/a: x.ts");
    expect(out).toContain("acme/b: x.ts");
  });

  it("returns 'no hits' when every repo yields zero results", async () => {
    const searchFiles = vi.fn(async () => []);
    const ctx = makeCtx(
      [makeRepo("acme", "a")],
      { searchFiles } as unknown as GithubMcpClient,
    );
    expect(await searchCodeTool.execute({ query: "foo" }, ctx)).toBe("no hits");
  });

  it("rejects empty query", async () => {
    const ctx = makeCtx([makeRepo("a", "b")], {} as GithubMcpClient);
    await expect(searchCodeTool.execute({ query: "" }, ctx)).rejects.toBeInstanceOf(
      ValidationError,
    );
  });
});
