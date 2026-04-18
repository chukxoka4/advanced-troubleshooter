import type { Tenant } from "../config/tenants.js";
import type { GithubMcpClient } from "../infrastructure/githubClient.js";
import { parse, type ParsedSymbol } from "../infrastructure/treeSitter.js";
import type { RepoMapRepository } from "../repositories/repoMap.repository.js";

/**
 * Repo-map service. Orchestrates:
 *   githubClient.listDir / readFile → treeSitter.parse → text outline →
 *   repoMap.repository.upsertMap.
 *
 * Rendering is scope-gated: renderForScope NEVER includes a repo that is
 * not in the allowedRepos list passed by the caller. All call sites are
 * expected to run allowedRepos through the isolation gate (Day 5) first.
 */

export interface TenantRepoPair {
  tenant: Pick<Tenant, "tenantId">;
  repo: {
    owner: string;
    name: string;
    defaultBranch: string;
    githubToken: string;
  };
}

export interface RepoMapService {
  build(pair: TenantRepoPair): Promise<{ repoFullName: string; symbolCount: number; headSha: string }>;
  refresh(pair: TenantRepoPair): Promise<{ repoFullName: string; refreshed: boolean; headSha: string }>;
  renderForScope(tenant: Pick<Tenant, "tenantId">, allowedRepos: string[]): Promise<string>;
}

export interface RepoMapServiceDeps {
  githubClient: GithubMcpClient;
  repoMapRepository: RepoMapRepository;
  // Optional caps so a pathological repo doesn't blow the budget. Defaults
  // chosen to keep a typical AM plugin well under a 50 KB rendered map.
  maxFiles?: number;
  maxFileBytes?: number;
}

// Secret patterns (subset of tenants.secretScan.ts) used to defensively
// strip secret-shaped substrings from rendered signatures. Source code
// should never contain real secrets — this is belt-and-braces.
const SECRET_PATTERNS: ReadonlyArray<RegExp> = [
  /ghp_[A-Za-z0-9]{10,}/g,
  /gho_[A-Za-z0-9]{10,}/g,
  /ghu_[A-Za-z0-9]{10,}/g,
  /ghs_[A-Za-z0-9]{10,}/g,
  /ghr_[A-Za-z0-9]{10,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /sk-ant-[A-Za-z0-9_-]{20,}/g,
  /sk-[A-Za-z0-9]{20,}/g,
  /AIza[A-Za-z0-9_-]{20,}/g,
  /xox[abprs]-[A-Za-z0-9-]{10,}/g,
  /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
];

// File extensions we try to parse. Must match treeSitter.ts loaders.
const SUPPORTED_EXTS = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "php", "go",
]);

// Directories we skip outright — vendor + build artefacts only bloat the map.
const SKIP_DIRS = new Set([
  "node_modules", "vendor", "dist", "build", ".git", ".next", ".nuxt",
  "coverage", "__pycache__", ".venv", "venv", "target",
]);

function extOf(path: string): string | null {
  const slash = path.lastIndexOf("/");
  const base = slash >= 0 ? path.slice(slash + 1) : path;
  const dot = base.lastIndexOf(".");
  if (dot < 0) return null;
  return base.slice(dot + 1).toLowerCase();
}

function stripSecrets(s: string): string {
  let out = s;
  for (const re of SECRET_PATTERNS) out = out.replace(re, "[REDACTED]");
  return out;
}

function renderFileBlock(path: string, symbols: ParsedSymbol[]): string {
  if (symbols.length === 0) return "";
  const header = `### ${path}`;
  const lines = symbols.map((s) => {
    const signature = stripSecrets(s.signature);
    return `- L${s.lineStart}-${s.lineEnd} ${s.kind} ${s.symbol}: ${signature}`;
  });
  return [header, ...lines].join("\n");
}

export function createRepoMapService(deps: RepoMapServiceDeps): RepoMapService {
  const maxFiles = deps.maxFiles ?? 200;
  const maxFileBytes = deps.maxFileBytes ?? 200_000;

  async function walk(
    repoRef: { owner: string; name: string; defaultBranch: string },
    token: string,
  ): Promise<string[]> {
    const files: string[] = [];
    const queue: string[] = [""];
    while (queue.length > 0 && files.length < maxFiles) {
      const dir = queue.shift() as string;
      const entries = await deps.githubClient.listDir(repoRef, dir, token);
      for (const entry of entries) {
        const base = entry.path.split("/").pop() ?? entry.path;
        if (SKIP_DIRS.has(base)) continue;
        if (entry.type === "dir") {
          queue.push(entry.path);
        } else if (entry.type === "file") {
          const ext = extOf(entry.path);
          if (ext && SUPPORTED_EXTS.has(ext)) {
            if (typeof entry.size === "number" && entry.size > maxFileBytes) continue;
            files.push(entry.path);
            if (files.length >= maxFiles) break;
          }
        }
      }
    }
    return files;
  }

  async function buildContent(pair: TenantRepoPair): Promise<{ content: string; symbolCount: number }> {
    const repoRef = {
      owner: pair.repo.owner,
      name: pair.repo.name,
      defaultBranch: pair.repo.defaultBranch,
    };
    const paths = await walk(repoRef, pair.repo.githubToken);
    const blocks: string[] = [];
    let symbolCount = 0;
    for (const path of paths) {
      const file = await deps.githubClient.readFile(repoRef, path, pair.repo.githubToken);
      const symbols = parse(file.content, path);
      if (symbols.length === 0) continue;
      symbolCount += symbols.length;
      blocks.push(renderFileBlock(path, symbols));
    }
    const header = `## ${pair.repo.owner}/${pair.repo.name} (branch: ${pair.repo.defaultBranch})`;
    const content = [header, ...blocks].join("\n\n");
    return { content, symbolCount };
  }

  return {
    async build(pair) {
      const repoFullName = `${pair.repo.owner}/${pair.repo.name}`;
      const headSha = await deps.githubClient.getCommitSha(
        { owner: pair.repo.owner, name: pair.repo.name, defaultBranch: pair.repo.defaultBranch },
        pair.repo.githubToken,
      );
      const { content, symbolCount } = await buildContent(pair);
      await deps.repoMapRepository.upsertMap({
        tenantId: pair.tenant.tenantId,
        repoFullName,
        defaultBranch: pair.repo.defaultBranch,
        headSha,
        content,
        symbolCount,
      });
      return { repoFullName, symbolCount, headSha };
    },

    async refresh(pair) {
      const repoFullName = `${pair.repo.owner}/${pair.repo.name}`;
      const headSha = await deps.githubClient.getCommitSha(
        { owner: pair.repo.owner, name: pair.repo.name, defaultBranch: pair.repo.defaultBranch },
        pair.repo.githubToken,
      );
      const existing = await deps.repoMapRepository.getMap(pair.tenant.tenantId, repoFullName);
      if (existing && existing.headSha === headSha) {
        return { repoFullName, refreshed: false, headSha };
      }
      const { content, symbolCount } = await buildContent(pair);
      await deps.repoMapRepository.upsertMap({
        tenantId: pair.tenant.tenantId,
        repoFullName,
        defaultBranch: pair.repo.defaultBranch,
        headSha,
        content,
        symbolCount,
      });
      return { repoFullName, refreshed: true, headSha };
    },

    async renderForScope(tenant, allowedRepos) {
      if (allowedRepos.length === 0) return "";
      const allowed = new Set(allowedRepos);
      const all = await deps.repoMapRepository.listMapsForTenant(tenant.tenantId);
      const scoped = all.filter((m) => allowed.has(m.repoFullName));
      if (scoped.length === 0) return "";
      return scoped.map((m) => m.content).join("\n\n");
    },
  };
}
