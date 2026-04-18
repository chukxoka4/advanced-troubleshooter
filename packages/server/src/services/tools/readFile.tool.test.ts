import { describe, expect, it, vi } from "vitest";
import type { GithubMcpClient } from "../../infrastructure/githubClient.js";
import type { RepoMapRepository } from "../../repositories/repoMap.repository.js";
import { ValidationError } from "../../shared/errors/index.js";
import type { TenantRepo } from "../repoScope.service.js";
import { readFileTool } from "./readFile.tool.js";
import type { ToolContext } from "./types.js";

const silentLogger: ToolContext["logger"] = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

function makeRepo(owner = "acme", name = "widgets"): TenantRepo {
  return { owner, name, githubToken: "tk", defaultBranch: "main" };
}

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  const allowedRepos = overrides.allowedRepos ?? [makeRepo()];
  return {
    tenant: {} as ToolContext["tenant"],
    allowedRepos,
    githubClient: overrides.githubClient ?? ({} as GithubMcpClient),
    repoMapRepository: overrides.repoMapRepository ?? ({} as RepoMapRepository),
    logger: silentLogger,
  };
}

describe("readFileTool", () => {
  it("rejects out-of-scope repo BEFORE calling githubClient", async () => {
    const readFileRange = vi.fn();
    const ctx = makeCtx({
      githubClient: { readFileRange } as unknown as GithubMcpClient,
    });
    await expect(
      readFileTool.execute({ repo: "attacker/other", path: "x.ts" }, ctx),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(readFileRange).not.toHaveBeenCalled();
  });

  it("clamps ranges beyond file length (delegated to githubClient.readFileRange)", async () => {
    const readFileRange = vi.fn(async () => ({
      repo: "acme/widgets",
      path: "x.ts",
      ref: "main",
      startLine: 1,
      endLine: 3,
      content: "a\nb\nc",
    }));
    const ctx = makeCtx({
      githubClient: { readFileRange } as unknown as GithubMcpClient,
    });
    const out = await readFileTool.execute(
      { repo: "acme/widgets", path: "x.ts", startLine: 1, endLine: 9999 },
      ctx,
    );
    expect(readFileRange).toHaveBeenCalledTimes(1);
    const call = readFileRange.mock.calls[0] as unknown as [
      unknown,
      string,
      number,
      number,
      string,
    ];
    expect(call[2]).toBe(1);
    expect(call[3]).toBeGreaterThan(1);
    expect(out).toContain("path: acme/widgets:x.ts");
    expect(out).toContain("lines: 1-3");
    expect(out).toContain("a\nb\nc");
    // Untrusted-data envelope is applied at the agent-loop layer (not here);
    // the tool returns raw content.
    expect(out).not.toContain("<untrusted_file_content>");
    expect(out).not.toContain("<untrusted_tool_output>");
  });

  it("returns the binary marker for NUL-containing content", async () => {
    const readFileRange = vi.fn(async () => ({
      repo: "acme/widgets",
      path: "bin.png",
      ref: "main",
      startLine: 1,
      endLine: 1,
      content: "\u0000\u0000",
    }));
    const ctx = makeCtx({
      githubClient: { readFileRange } as unknown as GithubMcpClient,
    });
    const out = await readFileTool.execute({ repo: "acme/widgets", path: "bin.png" }, ctx);
    expect(out).toBe("binary file, not readable");
  });

  it("defaults missing startLine to 1", async () => {
    const readFileRange = vi.fn(async () => ({
      repo: "acme/widgets",
      path: "x.ts",
      ref: "main",
      startLine: 1,
      endLine: 10,
      content: "line",
    }));
    const ctx = makeCtx({
      githubClient: { readFileRange } as unknown as GithubMcpClient,
    });
    await readFileTool.execute({ repo: "acme/widgets", path: "x.ts" }, ctx);
    const call = readFileRange.mock.calls[0] as unknown as [
      unknown,
      string,
      number,
      number,
      string,
    ];
    expect(call[2]).toBe(1);
  });

  it("rejects NaN / Infinity for startLine and endLine", async () => {
    const readFileRange = vi.fn();
    const ctx = makeCtx({
      githubClient: { readFileRange } as unknown as GithubMcpClient,
    });
    await expect(
      readFileTool.execute(
        { repo: "acme/widgets", path: "x.ts", startLine: Number.NaN },
        ctx,
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      readFileTool.execute(
        { repo: "acme/widgets", path: "x.ts", endLine: Number.POSITIVE_INFINITY },
        ctx,
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(readFileRange).not.toHaveBeenCalled();
  });
});
