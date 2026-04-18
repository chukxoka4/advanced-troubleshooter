import { describe, expect, it, vi } from "vitest";
import type { GithubMcpClient } from "../infrastructure/githubClient.js";
import type { RepoMapRepository, RepoMapRow } from "../repositories/repoMap.repository.js";
import { createRepoMapService, type TenantRepoPair } from "./repoMap.service.js";

function makePair(overrides: Partial<TenantRepoPair["repo"]> = {}): TenantRepoPair {
  return {
    tenant: { tenantId: "team-alpha" },
    repo: {
      owner: "team-alpha",
      name: "repo-a",
      defaultBranch: "main",
      githubToken: "tok",
      ...overrides,
    },
  };
}

function makeGithub(overrides: Partial<GithubMcpClient> = {}): GithubMcpClient {
  return {
    searchFiles: vi.fn(async () => []),
    readFile: vi.fn(async () => ({ repo: "x/y", path: "p", ref: "main", content: "" })),
    getRepo: vi.fn(async () => ({ owner: "x", name: "y", defaultBranch: "main", headSha: "sha" })),
    listDir: vi.fn(async () => []),
    getCommitSha: vi.fn(async () => "sha-0"),
    readFileRange: vi.fn(),
    ...overrides,
  } as unknown as GithubMcpClient;
}

function makeRepo(overrides: Partial<RepoMapRepository> = {}): {
  repo: RepoMapRepository;
  upsertMap: ReturnType<typeof vi.fn>;
  getMap: ReturnType<typeof vi.fn>;
  listMapsForTenant: ReturnType<typeof vi.fn>;
} {
  const upsertMap = vi.fn(async (input: {
    tenantId: string;
    repoFullName: string;
    defaultBranch: string;
    headSha: string;
    content: string;
    symbolCount: number;
  }): Promise<RepoMapRow> => ({
    id: "id",
    tenantId: input.tenantId,
    repoFullName: input.repoFullName,
    defaultBranch: input.defaultBranch,
    headSha: input.headSha,
    content: input.content,
    symbolCount: input.symbolCount,
    builtAt: new Date(),
  }));
  const getMap = vi.fn(async () => null as RepoMapRow | null);
  const listMapsForTenant = vi.fn(async () => [] as RepoMapRow[]);
  const repo: RepoMapRepository = {
    upsertMap,
    getMap,
    listMapsForTenant,
    ...overrides,
  };
  return { repo, upsertMap, getMap, listMapsForTenant };
}

// Tiny TS source the treeSitter wrapper recognises.
const TS_SAMPLE = "export function add(a: number, b: number): number { return a + b; }\n";

describe("repoMapService.build", () => {
  it("walks the repo, parses each supported file, and upserts exactly once", async () => {
    const listDir = vi.fn(async (_r: unknown, dir: string) => {
      if (dir === "") {
        return [
          { path: "src", type: "dir" as const },
          { path: "README.md", type: "file" as const, size: 10 },
        ];
      }
      if (dir === "src") {
        return [
          { path: "src/a.ts", type: "file" as const, size: 100 },
          { path: "src/b.ts", type: "file" as const, size: 100 },
        ];
      }
      return [];
    });
    const readFile = vi.fn(async () => ({
      repo: "team-alpha/repo-a",
      path: "x",
      ref: "main",
      content: TS_SAMPLE,
    }));
    const getCommitSha = vi.fn(async () => "sha-1");
    const github = makeGithub({
      listDir: listDir as unknown as GithubMcpClient["listDir"],
      readFile: readFile as unknown as GithubMcpClient["readFile"],
      getCommitSha: getCommitSha as unknown as GithubMcpClient["getCommitSha"],
    });
    const { repo, upsertMap } = makeRepo();
    const service = createRepoMapService({ githubClient: github, repoMapRepository: repo });

    const out = await service.build(makePair());

    expect(out.repoFullName).toBe("team-alpha/repo-a");
    expect(out.headSha).toBe("sha-1");
    expect(readFile).toHaveBeenCalledTimes(2);
    expect(upsertMap).toHaveBeenCalledTimes(1);
    const arg = upsertMap.mock.calls[0]?.[0] as { content: string; symbolCount: number };
    expect(arg.content).toContain("## team-alpha/repo-a");
    expect(arg.content).toContain("src/a.ts");
    expect(arg.content).toContain("src/b.ts");
    expect(arg.symbolCount).toBeGreaterThan(0);
  });

  it("skips vendor/node_modules directories", async () => {
    const listDir = vi.fn(async (_r: unknown, dir: string) => {
      if (dir === "") {
        return [
          { path: "node_modules", type: "dir" as const },
          { path: "src", type: "dir" as const },
        ];
      }
      if (dir === "src") {
        return [{ path: "src/a.ts", type: "file" as const, size: 10 }];
      }
      throw new Error(`unexpected listDir(${dir})`);
    });
    const github = makeGithub({
      listDir: listDir as unknown as GithubMcpClient["listDir"],
      readFile: (async () => ({ repo: "r", path: "p", ref: "main", content: TS_SAMPLE })) as unknown as GithubMcpClient["readFile"],
    });
    const { repo } = makeRepo();
    const service = createRepoMapService({ githubClient: github, repoMapRepository: repo });
    await service.build(makePair());
    // listDir called with "" and "src" only — never node_modules
    const dirs = listDir.mock.calls.map((c) => c[1]);
    expect(dirs).not.toContain("node_modules");
  });
});

describe("repoMapService.refresh", () => {
  it("is a no-op when headSha is unchanged", async () => {
    const github = makeGithub({
      getCommitSha: (async () => "sha-same") as unknown as GithubMcpClient["getCommitSha"],
    });
    const { repo, upsertMap, getMap } = makeRepo();
    getMap.mockResolvedValue({
      id: "id",
      tenantId: "team-alpha",
      repoFullName: "team-alpha/repo-a",
      defaultBranch: "main",
      headSha: "sha-same",
      content: "existing",
      symbolCount: 1,
      builtAt: new Date(),
    } satisfies RepoMapRow);
    const service = createRepoMapService({ githubClient: github, repoMapRepository: repo });

    const result = await service.refresh(makePair());
    expect(result.refreshed).toBe(false);
    expect(upsertMap).not.toHaveBeenCalled();
  });

  it("rebuilds when headSha changed", async () => {
    const github = makeGithub({
      getCommitSha: (async () => "sha-new") as unknown as GithubMcpClient["getCommitSha"],
      listDir: (async () => [
        { path: "a.ts", type: "file" as const, size: 10 },
      ]) as unknown as GithubMcpClient["listDir"],
      readFile: (async () => ({
        repo: "r", path: "p", ref: "main", content: TS_SAMPLE,
      })) as unknown as GithubMcpClient["readFile"],
    });
    const { repo, upsertMap, getMap } = makeRepo();
    getMap.mockResolvedValue({
      id: "id",
      tenantId: "team-alpha",
      repoFullName: "team-alpha/repo-a",
      defaultBranch: "main",
      headSha: "sha-old",
      content: "old",
      symbolCount: 1,
      builtAt: new Date(),
    } satisfies RepoMapRow);
    const service = createRepoMapService({ githubClient: github, repoMapRepository: repo });

    const result = await service.refresh(makePair());
    expect(result.refreshed).toBe(true);
    expect(result.headSha).toBe("sha-new");
    expect(upsertMap).toHaveBeenCalledTimes(1);
  });
});

describe("repoMapService.renderForScope", () => {
  function rowOf(repoFullName: string, content: string): RepoMapRow {
    return {
      id: repoFullName,
      tenantId: "team-alpha",
      repoFullName,
      defaultBranch: "main",
      headSha: "sha",
      content,
      symbolCount: 1,
      builtAt: new Date(),
    };
  }

  it("includes only repos in the allowed list; out-of-scope repos never appear", async () => {
    const { repo, listMapsForTenant } = makeRepo();
    listMapsForTenant.mockResolvedValue([
      rowOf("team-alpha/repo-a", "## team-alpha/repo-a\n- L1-3 function inScope"),
      rowOf("team-alpha/secret-repo", "## team-alpha/secret-repo\n- L1-3 function SHOULD_NOT_APPEAR"),
    ]);
    const github = makeGithub();
    const service = createRepoMapService({ githubClient: github, repoMapRepository: repo });

    const out = await service.renderForScope(
      { tenantId: "team-alpha" },
      ["team-alpha/repo-a"],
    );
    expect(out).toContain("team-alpha/repo-a");
    expect(out).toMatch(/inScope/);
    expect(out).not.toMatch(/secret-repo/);
    expect(out).not.toMatch(/SHOULD_NOT_APPEAR/);
  });

  it("returns empty when allowedRepos is empty", async () => {
    const { repo } = makeRepo();
    const github = makeGithub();
    const service = createRepoMapService({ githubClient: github, repoMapRepository: repo });
    const out = await service.renderForScope({ tenantId: "team-alpha" }, []);
    expect(out).toBe("");
  });
});

describe("repoMapService sanitisation", () => {
  it("strips secret-shaped tokens from rendered signatures before upsert", async () => {
    // A source file whose first line contains a secret-shaped string. In
    // practice source code should never contain these, but the render
    // path must scrub them defensively so the LLM context cannot
    // exfiltrate an accidentally-committed secret.
    // The secret must sit on the *signature* line (the node's first line)
    // so the renderer captures it; stripSecrets is then responsible for
    // redacting it. We put the ghp_ token in a default-parameter string.
    const leaky =
      "function leak(token: string = \"ghp_aaaaaaaaaaaaaaaaaaaaaaaa\"): string { return token; }\n";
    const github = makeGithub({
      listDir: (async () => [
        { path: "leak.ts", type: "file" as const, size: 200 },
      ]) as unknown as GithubMcpClient["listDir"],
      readFile: (async () => ({
        repo: "team-alpha/repo-a", path: "leak.ts", ref: "main", content: leaky,
      })) as unknown as GithubMcpClient["readFile"],
    });
    const { repo, upsertMap } = makeRepo();
    const service = createRepoMapService({ githubClient: github, repoMapRepository: repo });

    await service.build(makePair());
    const arg = upsertMap.mock.calls[0]?.[0] as { content: string };
    expect(arg.content).not.toMatch(/ghp_[A-Za-z0-9]+/);
    expect(arg.content).toContain("[REDACTED]");
  });
});
