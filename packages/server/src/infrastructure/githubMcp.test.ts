import { describe, expect, it, vi } from "vitest";
import { createGithubMcpClient } from "./githubMcp.js";

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
    await client.searchFiles("q", repo, "t", { limit: 999 });
    const [url] = fetchImpl.mock.calls[0] as [string];
    expect(url).toContain("per_page=30");
  });

  it("searchFiles throws on non-2xx", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("nope", { status: 403, statusText: "Forbidden" }),
    );
    const client = createGithubMcpClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(client.searchFiles("q", repo, "t")).rejects.toThrow(/403/);
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
});
