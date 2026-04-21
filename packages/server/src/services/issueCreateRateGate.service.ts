import type { Tenant } from "../config/tenants.js";
import { RateLimitError } from "../shared/errors/index.js";

const HOUR_MS = 3_600_000;

/**
 * In-process hourly cap on GitHub issue creation per tenant. Keys roll with
 * UTC wall-clock hours derived from `now()`; entries older than 48 hours
 * are pruned when the map grows large (prototype — replace with Redis/DB
 * for multi-instance production).
 */

export interface IssueCreateRateGate {
  tryConsume(tenant: Pick<Tenant, "tenantId" | "rateLimits">): void;
}

export interface IssueCreateRateGateOptions {
  now?: () => number;
}

function hourEpoch(ms: number): number {
  return Math.floor(ms / HOUR_MS);
}

export function createIssueCreateRateGate(options: IssueCreateRateGateOptions = {}): IssueCreateRateGate {
  const now = options.now ?? (() => Date.now());
  const counts = new Map<string, number>();

  function prune(currentHe: number): void {
    if (counts.size < 5_000) return;
    for (const k of counts.keys()) {
      const tab = k.lastIndexOf("\t");
      if (tab < 0) continue;
      const he = Number(k.slice(tab + 1));
      if (Number.isFinite(he) && currentHe - he > 48) counts.delete(k);
    }
  }

  return {
    tryConsume(tenant) {
      const he = hourEpoch(now());
      prune(he);
      const key = `${tenant.tenantId}\t${he}`;
      const limit = tenant.rateLimits.issuesPerHour;
      const next = (counts.get(key) ?? 0) + 1;
      if (next > limit) {
        throw new RateLimitError("Issue creation rate limit exceeded. Try again later.");
      }
      counts.set(key, next);
    },
  };
}
