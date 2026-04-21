import { ForbiddenError, ValidationError } from "../shared/errors/index.js";

/**
 * Creates GitHub issues via REST. Write token never leaves this module's
 * call sites — the service tool passes it per request from tenant config.
 */

export interface CreateIssuePayload {
  title: string;
  body: string;
  labels?: string[];
}

export interface CreatedIssue {
  url: string;
  number: number;
}

export interface IssueCreator {
  create(repoFullName: string, payload: CreateIssuePayload, writeToken: string): Promise<CreatedIssue>;
}

export interface IssueCreatorOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  userAgent?: string;
}

const DEFAULT_BASE_URL = "https://api.github.com";
const DEFAULT_USER_AGENT = "advanced-troubleshooter/0.0";

function authHeaders(token: string, userAgent: string): Record<string, string> {
  if (!token || token.length === 0) throw new Error("write token is required");
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": userAgent,
    "Content-Type": "application/json",
  };
}

export function createIssueCreator(options: IssueCreatorOptions = {}): IssueCreator {
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const userAgent = options.userAgent ?? DEFAULT_USER_AGENT;

  if (typeof fetchImpl !== "function") {
    throw new Error("fetch is not available — provide options.fetchImpl");
  }

  return {
    async create(repoFullName, payload, writeToken) {
      const parts = repoFullName.split("/");
      const owner = parts[0];
      const name = parts[1];
      if (!owner || !name || parts.length !== 2) {
        throw new ValidationError("invalid repository name");
      }
      const url = `${baseUrl}/repos/${owner}/${name}/issues`;
      const response = await fetchImpl(url, {
        method: "POST",
        headers: authHeaders(writeToken, userAgent),
        body: JSON.stringify({
          title: payload.title,
          body: payload.body,
          ...(payload.labels && payload.labels.length > 0 ? { labels: payload.labels } : {}),
        }),
      });

      if (response.status === 422) {
        throw new ValidationError("GitHub rejected the issue payload.");
      }
      if (response.status === 403) {
        throw new ForbiddenError("GitHub denied issue creation for this token.");
      }
      if (!response.ok) {
        throw new Error(`github api ${response.status} ${response.statusText} for ${new URL(url).pathname}`);
      }
      const body = (await response.json()) as { html_url?: string; number?: number };
      if (typeof body.html_url !== "string" || typeof body.number !== "number") {
        throw new Error("unexpected github issue create response");
      }
      return { url: body.html_url, number: body.number };
    },
  };
}
