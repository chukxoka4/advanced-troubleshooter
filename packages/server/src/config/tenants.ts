import { readdir, readFile } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NotFoundError, ValidationError } from "../shared/errors/index.js";
import { TenantConfigSchema, type Tenant } from "./tenants.schema.js";
import { scanForRawSecrets } from "./tenants.secretScan.js";

/**
 * Tenant config loader.
 *
 * 1. Lists *.json files in the tenants directory (underscore-prefixed files
 *    such as _template.json are skipped — they document the schema without
 *    representing a real tenant).
 * 2. Runs the raw-secret scan so a committed token is rejected immediately.
 * 3. Resolves ${ENV_VAR} placeholders from process.env.
 * 4. Validates the resolved shape against TenantConfigSchema.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_TENANTS_DIR = resolve(__dirname, "..", "..", "tenants");
const ENV_REF_PATTERN = /^\$\{([A-Z_][A-Z0-9_]*)\}$/;

export { TenantConfigSchema } from "./tenants.schema.js";
export type { Tenant, AiProvider } from "./tenants.schema.js";

export interface LoadTenantsOptions {
  dir?: string;
  env?: NodeJS.ProcessEnv;
}

export interface LoadedTenants {
  getTenant(id: string): Tenant;
  allTenantIds(): string[];
  all(): Tenant[];
}

function resolveEnvRefs(value: unknown, env: NodeJS.ProcessEnv, path: string[] = []): unknown {
  if (typeof value === "string") {
    const match = ENV_REF_PATTERN.exec(value);
    if (!match) return value;
    const envName = match[1]!;
    const resolved = env[envName];
    if (resolved === undefined || resolved.length === 0) {
      const where = path.length === 0 ? "(root)" : path.join(".");
      throw new ValidationError(
        `environment variable ${envName} referenced at ${where} is not set`,
      );
    }
    return resolved;
  }
  if (Array.isArray(value)) {
    return value.map((item, idx) => resolveEnvRefs(item, env, [...path, `[${idx}]`]));
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out[key] = resolveEnvRefs(child, env, [...path, key]);
    }
    return out;
  }
  return value;
}

export async function loadTenants(options: LoadTenantsOptions = {}): Promise<LoadedTenants> {
  const dir = options.dir ?? DEFAULT_TENANTS_DIR;
  const env = options.env ?? process.env;

  const entries = await readdir(dir);
  const jsonFiles = entries
    .filter((file) => extname(file) === ".json" && !file.startsWith("_"))
    .sort();

  const byId = new Map<string, Tenant>();

  for (const file of jsonFiles) {
    const rawText = await readFile(join(dir, file), "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawText);
    } catch (error) {
      throw new ValidationError(
        `tenant config ${file} is not valid JSON: ${(error as Error).message}`,
      );
    }

    scanForRawSecrets(file, parsed);
    const resolved = resolveEnvRefs(parsed, env);

    const result = TenantConfigSchema.safeParse(resolved);
    if (!result.success) {
      throw new ValidationError(
        `tenant config ${file} failed validation: ${result.error.message}`,
      );
    }

    if (byId.has(result.data.tenantId)) {
      throw new ValidationError(
        `duplicate tenantId "${result.data.tenantId}" detected (already loaded from a previous file)`,
      );
    }

    byId.set(result.data.tenantId, result.data);
  }

  return {
    getTenant(id: string): Tenant {
      const tenant = byId.get(id);
      if (!tenant) throw new NotFoundError(`tenant "${id}" not found`);
      return tenant;
    },
    allTenantIds(): string[] {
      return [...byId.keys()];
    },
    all(): Tenant[] {
      return [...byId.values()];
    },
  };
}
