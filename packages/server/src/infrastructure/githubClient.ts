/**
 * GitHub code-access client. The architecture treats this as the "MCP"
 * surface: a read-only façade over GitHub that exposes two operations the AI
 * service needs — search for files matching a query, and read the contents
 * of a specific file. Implemented against the GitHub REST API so it works
 * against any token without a separate MCP runtime.
 *
 * Scope is deliberately narrow. No write paths, no repo listings, no admin.
 * The token passed in is a per-repo `contents:read` fine-grained PAT and
 * never leaves this module.
 */

export interface RepoRef {
  owner: string;
  name: string;
  defaultBranch?: string;
}

export interface SearchHit {
  repo: string;
  path: string;
  url: string;
}

export interface FileContents {
  repo: string;
  path: string;
  ref: string;
  content: string;
}

export interface RepoMeta {
  owner: string;
  name: string;
  defaultBranch: string;
  headSha: string;
}

export interface DirEntry {
  path: string;
  type: "file" | "dir";
  size?: number;
}

export interface FileRange {
  repo: string;
  path: string;
  ref: string;
  startLine: number;
  endLine: number;
  content: string;
}

export interface GithubMcpClient {
  searchFiles(
    query: string,
    repo: RepoRef,
    token: string,
    options?: { limit?: number },
  ): Promise<SearchHit[]>;
  readFile(repo: RepoRef, path: string, token: string): Promise<FileContents>;
  getRepo(repo: RepoRef, token: string): Promise<RepoMeta>;
  listDir(repo: RepoRef, path: string, token: string): Promise<DirEntry[]>;
  getCommitSha(repo: RepoRef, token: string, ref?: string): Promise<string>;
  readFileRange(
    repo: RepoRef,
    path: string,
    startLine: number,
    endLine: number,
    token: string,
  ): Promise<FileRange>;
}

// Back-compat alias: the client used to live in `githubMcp.ts`.
export type GithubClient = GithubMcpClient;

export interface GithubMcpOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  userAgent?: string;
}

const DEFAULT_BASE_URL = "https://api.github.com";
const DEFAULT_USER_AGENT = "advanced-troubleshooter/0.0";
const MAX_SEARCH_LIMIT = 30;

/**
 * GitHub code-search query tokeniser.
 *
 * `/search/code` parses its `q` parameter as a structured search expression.
 * Parentheses, colons, slashes (outside a `repo:` qualifier), and leading
 * dashes are all syntactically meaningful; a natural-language question
 * that contains any of them is rejected with HTTP 422
 * `ERROR_TYPE_QUERY_PARSING_FATAL`. aiService previously forwarded the raw
 * user question straight to this endpoint, so any question containing
 * `(owner/name)` or similar punctuation 500'd the /api/v1/chat request.
 *
 * This sanitiser extracts up to MAX_SEARCH_TOKENS alphanumeric
 * identifier-shaped tokens from the raw text, de-duplicated
 * case-insensitively, and joins them with spaces. The result is always a
 * valid GitHub code-search query — free of parser metacharacters — and is
 * also better input for code search itself (keywords over natural
 * language). Exposed for testing; searchFiles below is the only caller.
 */
const SEARCH_TOKEN_PATTERN = /[A-Za-z][A-Za-z0-9_]{2,}/g;
const MAX_SEARCH_TOKENS = 10;

export function toSearchQuery(raw: string): string {
  const tokens = raw.match(SEARCH_TOKEN_PATTERN) ?? [];
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const token of tokens) {
    const lower = token.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    unique.push(token);
    if (unique.length === MAX_SEARCH_TOKENS) break;
  }
  return unique.join(" ");
}

function requireToken(token: string): string {
  if (!token || token.length === 0) {
    throw new Error("github token is required");
  }
  return token;
}

function authHeaders(token: string, userAgent: string): Record<string, string> {
  return {
    Authorization: `Bearer ${requireToken(token)}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": userAgent,
  };
}

async function githubGet(
  url: string,
  token: string,
  fetchImpl: typeof fetch,
  userAgent: string,
): Promise<unknown> {
  const response = await fetchImpl(url, { headers: authHeaders(token, userAgent) });
  if (!response.ok) {
    // Intentionally omit the query string from the thrown message — for the
    // code-search endpoint it contains user-supplied search text, which
    // belongs in structured logs (and only after the caller has scrubbed PII)
    // rather than in the Error surface.
    const path = new URL(url).pathname;
    throw new Error(`github api ${response.status} ${response.statusText} for ${path}`);
  }
  return (await response.json()) as unknown;
}

export function createGithubMcpClient(options: GithubMcpOptions = {}): GithubMcpClient {
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const userAgent = options.userAgent ?? DEFAULT_USER_AGENT;

  if (typeof fetchImpl !== "function") {
    throw new Error("fetch is not available — provide options.fetchImpl");
  }

  return {
    async searchFiles(query, repo, token, searchOptions = {}) {
      requireToken(token);
      const limit = Math.min(searchOptions.limit ?? 10, MAX_SEARCH_LIMIT);
      const safeQuery = toSearchQuery(query);
      // Short-circuit: if the sanitised query has no usable tokens (e.g.
      // the user's question was all punctuation or all short words), skip
      // the GitHub call entirely. Sending an empty `q` param to
      // /search/code returns 422 — return an empty hit list instead so
      // aiService can fall through to its "no repository context" path.
      if (safeQuery.length === 0) return [];
      const q = `${safeQuery} repo:${repo.owner}/${repo.name}`;
      const url = `${baseUrl}/search/code?q=${encodeURIComponent(q)}&per_page=${limit}`;
      const body = (await githubGet(url, token, fetchImpl, userAgent)) as {
        items?: Array<{ path?: string; html_url?: string }>;
      };
      const items = Array.isArray(body.items) ? body.items : [];
      return items
        .filter((i) => typeof i.path === "string" && typeof i.html_url === "string")
        .map((i) => ({
          repo: `${repo.owner}/${repo.name}`,
          path: i.path as string,
          url: i.html_url as string,
        }));
    },

    async readFile(repo, path, token) {
      const ref = repo.defaultBranch ?? "main";
      const safePath = path.split("/").map(encodeURIComponent).join("/");
      const url = `${baseUrl}/repos/${repo.owner}/${repo.name}/contents/${safePath}?ref=${encodeURIComponent(ref)}`;
      const body = (await githubGet(url, token, fetchImpl, userAgent)) as {
        content?: string;
        encoding?: string;
        type?: string;
      };
      if (body.type !== "file") {
        throw new Error(`github path ${repo.owner}/${repo.name}:${path} is not a file`);
      }
      if (body.encoding !== "base64" || typeof body.content !== "string") {
        throw new Error(`unexpected github contents payload for ${path}`);
      }
      const content = Buffer.from(body.content, "base64").toString("utf8");
      return { repo: `${repo.owner}/${repo.name}`, path, ref, content };
    },

    async getRepo(repo, token) {
      requireToken(token);
      const url = `${baseUrl}/repos/${repo.owner}/${repo.name}`;
      const body = (await githubGet(url, token, fetchImpl, userAgent)) as {
        default_branch?: string;
      };
      const defaultBranch = typeof body.default_branch === "string" ? body.default_branch : "main";
      const headSha = await this.getCommitSha({ ...repo, defaultBranch }, token, defaultBranch);
      return { owner: repo.owner, name: repo.name, defaultBranch, headSha };
    },

    async listDir(repo, path, token) {
      requireToken(token);
      const ref = repo.defaultBranch ?? "main";
      const safePath = path
        .split("/")
        .filter((p) => p.length > 0)
        .map(encodeURIComponent)
        .join("/");
      const suffix = safePath.length > 0 ? `/${safePath}` : "";
      const url = `${baseUrl}/repos/${repo.owner}/${repo.name}/contents${suffix}?ref=${encodeURIComponent(ref)}`;
      const body = (await githubGet(url, token, fetchImpl, userAgent)) as
        | Array<{ path?: string; type?: string; size?: number }>
        | { path?: string; type?: string };
      if (!Array.isArray(body)) {
        // listDir on a file → return a single entry so callers can uniformly treat the result
        if (typeof body.path === "string" && (body.type === "file" || body.type === "dir")) {
          return [{ path: body.path, type: body.type }];
        }
        return [];
      }
      return body
        .filter(
          (i): i is { path: string; type: "file" | "dir"; size?: number } =>
            typeof i.path === "string" && (i.type === "file" || i.type === "dir"),
        )
        .map((i) => {
          const entry: DirEntry = { path: i.path, type: i.type };
          if (typeof i.size === "number") entry.size = i.size;
          return entry;
        });
    },

    async getCommitSha(repo, token, ref) {
      requireToken(token);
      const branch = ref ?? repo.defaultBranch ?? "main";
      const url = `${baseUrl}/repos/${repo.owner}/${repo.name}/commits/${encodeURIComponent(branch)}`;
      const body = (await githubGet(url, token, fetchImpl, userAgent)) as { sha?: string };
      if (typeof body.sha !== "string" || body.sha.length === 0) {
        throw new Error(`github commit sha missing for ${repo.owner}/${repo.name}@${branch}`);
      }
      return body.sha;
    },

    async readFileRange(repo, path, startLine, endLine, token) {
      const file = await this.readFile(repo, path, token);
      const lines = file.content.split(/\r?\n/);
      const total = lines.length;
      // clamp to [1, total]
      const s = Math.max(1, Math.min(startLine, total));
      const e = Math.max(s, Math.min(endLine, total));
      const slice = lines.slice(s - 1, e).join("\n");
      return {
        repo: file.repo,
        path: file.path,
        ref: file.ref,
        startLine: s,
        endLine: e,
        content: slice,
      };
    },
  };
}
