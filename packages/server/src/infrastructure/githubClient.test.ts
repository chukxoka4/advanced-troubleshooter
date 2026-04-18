import { describe, expect, it, vi } from "vitest";
import { createGithubMcpClient, toSearchQuery } from "./githubClient.js";

function jsonResponse(body: unknown, init: Partial<ResponseInit> = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    statusText: init.statusText ?? "OK",
    headers: { "Content-Type": "application/json" },
  });
}

describe("githubMcp client", () => {
  const repo = { owner: "awesomemotive", name: "wpforms", defaultBranch: "trunk" };

  it("searchFiles hits the search/code endpoint with repo scope and auth", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        items: [
          { path: "src/form.php", html_url: "https://github.com/x/y/blob/main/src/form.php" },
          { path: "src/submit.php", html_url: "https://github.com/x/y/blob/main/src/submit.php" },
        ],
      }),
    );
    const client = createGithubMcpClient({ fetchImpl: fetchImpl as unknown as typeof fetch });

    const hits = await client.searchFiles("submit", repo, "ghp_token", { limit: 5 });

    expect(hits).toHaveLength(2);
    expect(hits[0]).toMatchObject({ repo: "awesomemotive/wpforms", path: "src/form.php" });

    const [calledUrl, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(calledUrl).toContain("/search/code?q=");
    expect(calledUrl).toContain(encodeURIComponent("repo:awesomemotive/wpforms"));
    expect(calledUrl).toContain("per_page=5");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer ghp_token");
    expect(headers.Accept).toBe("application/vnd.github+json");
  });

  it("searchFiles caps the limit at 30", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ items: [] }));
    const client = createGithubMcpClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    await client.searchFiles("submit", repo, "t", { limit: 999 });
    const [url] = fetchImpl.mock.calls[0] as [string];
    expect(url).toContain("per_page=30");
  });

  it("searchFiles throws on non-2xx", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("nope", { status: 403, statusText: "Forbidden" }),
    );
    const client = createGithubMcpClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(client.searchFiles("submit", repo, "t")).rejects.toThrow(/403/);
  });

  it("readFile decodes base64 contents and uses the repo defaultBranch", async () => {
    const content = "Buffer.from test — déjà vu";
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        type: "file",
        encoding: "base64",
        content: Buffer.from(content, "utf8").toString("base64"),
      }),
    );
    const client = createGithubMcpClient({ fetchImpl: fetchImpl as unknown as typeof fetch });

    const file = await client.readFile(repo, "src/index.ts", "tok");

    expect(file.content).toBe(content);
    expect(file.ref).toBe("trunk");
    const [url] = fetchImpl.mock.calls[0] as [string];
    expect(url).toContain("/repos/awesomemotive/wpforms/contents/src/index.ts");
    expect(url).toContain("ref=trunk");
  });

  it("readFile URL-encodes path segments but preserves slashes", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ type: "file", encoding: "base64", content: "" }),
    );
    const client = createGithubMcpClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    await client.readFile(repo, "dir with space/file.ts", "tok");
    const [url] = fetchImpl.mock.calls[0] as [string];
    expect(url).toContain("/contents/dir%20with%20space/file.ts");
  });

  it("readFile rejects non-file payloads", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse([{ type: "dir", name: "sub" }]),
    );
    const client = createGithubMcpClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(client.readFile(repo, "src", "tok")).rejects.toThrow(/not a file/);
  });

  it("throws when token is empty", async () => {
    const fetchImpl = vi.fn();
    const client = createGithubMcpClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(client.searchFiles("q", repo, "")).rejects.toThrow(/github token/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("searchFiles short-circuits (no fetch) when the question sanitises to empty", async () => {
    const fetchImpl = vi.fn();
    const client = createGithubMcpClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const hits = await client.searchFiles("?? () // a of", repo, "tok");
    expect(hits).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("getRepo returns metadata plus head SHA from the default branch", async () => {
    const fetchImpl = vi.fn();
    fetchImpl
      .mockResolvedValueOnce(jsonResponse({ default_branch: "trunk" }))
      .mockResolvedValueOnce(jsonResponse({ sha: "abc123" }));
    const client = createGithubMcpClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const meta = await client.getRepo({ owner: "awesomemotive", name: "wpforms" }, "tok");
    expect(meta).toEqual({
      owner: "awesomemotive",
      name: "wpforms",
      defaultBranch: "trunk",
      headSha: "abc123",
    });
    const [firstUrl] = fetchImpl.mock.calls[0] as [string];
    expect(firstUrl).toContain("/repos/awesomemotive/wpforms");
    const [secondUrl] = fetchImpl.mock.calls[1] as [string];
    expect(secondUrl).toContain("/commits/trunk");
  });

  it("listDir returns entries from the contents endpoint", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse([
        { path: "src/index.ts", type: "file", size: 120 },
        { path: "src/sub", type: "dir" },
        { path: "README.md", type: "file", size: 10 },
      ]),
    );
    const client = createGithubMcpClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const entries = await client.listDir(repo, "src", "tok");
    expect(entries).toHaveLength(3);
    expect(entries[0]).toMatchObject({ path: "src/index.ts", type: "file", size: 120 });
    const [url] = fetchImpl.mock.calls[0] as [string];
    expect(url).toContain("/repos/awesomemotive/wpforms/contents/src");
    expect(url).toContain("ref=trunk");
  });

  it("listDir with empty path lists the repo root", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse([]));
    const client = createGithubMcpClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    await client.listDir(repo, "", "tok");
    const [url] = fetchImpl.mock.calls[0] as [string];
    expect(url).toContain("/repos/awesomemotive/wpforms/contents?ref=trunk");
  });

  it("getCommitSha resolves a branch to a SHA", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ sha: "deadbeef" }));
    const client = createGithubMcpClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const sha = await client.getCommitSha(repo, "tok");
    expect(sha).toBe("deadbeef");
    const [url] = fetchImpl.mock.calls[0] as [string];
    expect(url).toContain("/commits/trunk");
  });

  it("getCommitSha throws if GitHub returns no sha", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}));
    const client = createGithubMcpClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(client.getCommitSha(repo, "tok")).rejects.toThrow(/sha missing/);
  });

  it("readFileRange clamps start/end to the file length", async () => {
    const body = "line1\nline2\nline3\nline4\nline5";
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        type: "file",
        encoding: "base64",
        content: Buffer.from(body, "utf8").toString("base64"),
      }),
    );
    const client = createGithubMcpClient({ fetchImpl: fetchImpl as unknown as typeof fetch });

    const slice = await client.readFileRange(repo, "x.ts", 2, 4, "tok");
    expect(slice.content).toBe("line2\nline3\nline4");
    expect(slice.startLine).toBe(2);
    expect(slice.endLine).toBe(4);

    const clampedHigh = await client.readFileRange(repo, "x.ts", 3, 999, "tok");
    expect(clampedHigh.endLine).toBe(5);
    expect(clampedHigh.content).toBe("line3\nline4\nline5");

    const clampedLow = await client.readFileRange(repo, "x.ts", -5, 2, "tok");
    expect(clampedLow.startLine).toBe(1);
    expect(clampedLow.content).toBe("line1\nline2");

    const inverted = await client.readFileRange(repo, "x.ts", 4, 1, "tok");
    expect(inverted.startLine).toBe(4);
    expect(inverted.endLine).toBe(4);
  });

  it("searchFiles sanitises the raw question before hitting GitHub — regression for the 422 produced by the Phase 1 milestone question", async () => {
    // This is the exact user question that caused an HTTP 500 in
    // production on 2026-04-17: GitHub rejected the raw string with
    // HTTP 422 ERROR_TYPE_QUERY_PARSING_FATAL because of the `(owner/name)`
    // parenthesised expression. The sanitiser must collapse the
    // question to a valid identifier-only query and preserve the repo
    // qualifier so code search is still scoped correctly.
    const rawQuestion =
      "For each repository you have access to, read the README and summarise " +
      "what it does in one sentence. Output the full repo name (owner/name) " +
      "followed by the summary, one repo per line.";
    const fetchImpl = vi.fn(async () => jsonResponse({ items: [] }));
    const client = createGithubMcpClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    await client.searchFiles(rawQuestion, repo, "tok");
    const [url] = fetchImpl.mock.calls[0] as [string];
    const rawQ = url.split("?q=")[1]?.split("&")[0] ?? "";
    const decodedQ = decodeURIComponent(rawQ);
    // The query GitHub receives is "<sanitised tokens> repo:owner/name".
    // Split on the repo qualifier so we can assert invariants on each
    // half independently: the sanitised portion must be free of parser
    // metacharacters, while the qualifier legitimately contains a slash.
    const qualifierMarker = " repo:";
    const qualifierIndex = decodedQ.indexOf(qualifierMarker);
    expect(qualifierIndex).toBeGreaterThan(0);
    const sanitisedPortion = decodedQ.slice(0, qualifierIndex);
    const qualifierPortion = decodedQ.slice(qualifierIndex);
    // None of the parser metacharacters that caused the production 422
    // may appear in the user-controlled portion.
    expect(sanitisedPortion).not.toMatch(/[()\\,\/:]/);
    // Real tokens from the question are preserved, so code search still
    // has something meaningful to match on.
    expect(sanitisedPortion.toLowerCase()).toContain("repository");
    expect(sanitisedPortion).toContain("README");
    // The structured repo qualifier is appended *after* sanitisation —
    // sanitisation only runs on the raw user query, never on our suffix.
    expect(qualifierPortion).toBe(" repo:awesomemotive/wpforms");
  });
});

describe("toSearchQuery", () => {
  const cases: ReadonlyArray<[string, string]> = [
    ["", ""],
    ["hello world", "hello world"],
    // Short filler words (<3 chars) are stripped.
    ["a of is it an or to", ""],
    // Pure punctuation / metacharacters produce nothing.
    ["()()/\\:?!,;", ""],
    // Leading dashes would otherwise be read as GitHub negation — stripped.
    ["-foo --bar", "foo bar"],
    // Case-insensitive dedup preserves first occurrence's casing.
    ["Repeat repeat REPEAT different", "Repeat different"],
    // Hyphens and dots split identifiers (tokens containing them break apart).
    ["api-contracts package.json auth.ts", "api contracts package json auth"],
    // Underscores are part of identifiers and preserved.
    ["snake_case_thing AnotherOne", "snake_case_thing AnotherOne"],
    // Question-shaped text that used to 422 GitHub.
    [
      "What does sharedKeyVerifier do, and why does it hash both keys before comparing them?",
      "What does sharedKeyVerifier and why hash both keys before comparing",
    ],
  ];

  for (const [input, expected] of cases) {
    it(`sanitises ${JSON.stringify(input)} → ${JSON.stringify(expected)}`, () => {
      expect(toSearchQuery(input)).toBe(expected);
    });
  }

  it("caps the output at 10 unique tokens", () => {
    const input = Array.from({ length: 50 }, (_, i) => `wordAAA${i}`).join(" ");
    const result = toSearchQuery(input).split(" ").filter(Boolean);
    expect(result).toHaveLength(10);
  });

  it("never includes GitHub parser metacharacters in its output", () => {
    const hostile = "(A or B) AND path:/etc/passwd -deny repo:x/y";
    const out = toSearchQuery(hostile);
    expect(out).not.toMatch(/[()\/:\-]/);
  });
});
