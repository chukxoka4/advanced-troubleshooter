import type { FastifyInstance, FastifyRequest } from "fastify";
import { RateLimitError } from "../shared/errors/index.js";

/**
 * In-memory fixed-window rate limiter. Bucket key is tenantId when one is
 * attached (production), or "__anonymous__" otherwise (prototype or
 * pre-tenantResolver paths). In-memory is fine for a single-instance
 * prototype; horizontally-scaled production swaps the store for Redis
 * without changing the middleware shape.
 */

const WINDOW_MS = 60_000;

interface Bucket {
  count: number;
  resetAt: number;
}

export interface RateLimiterOptions {
  getLimit: (req: FastifyRequest) => number;
  store?: Map<string, Bucket>;
  now?: () => number;
  keyFor?: (req: FastifyRequest) => string;
}

export async function registerRateLimiter(
  app: FastifyInstance,
  options: RateLimiterOptions,
): Promise<void> {
  const store = options.store ?? new Map<string, Bucket>();
  const now = options.now ?? (() => Date.now());
  const keyFor = options.keyFor ?? ((req) => req.tenant?.tenantId ?? "__anonymous__");

  app.addHook("onRequest", async (req: FastifyRequest) => {
    const limit = options.getLimit(req);
    const key = keyFor(req);
    const current = now();
    const bucket = store.get(key);

    if (!bucket || bucket.resetAt <= current) {
      store.set(key, { count: 1, resetAt: current + WINDOW_MS });
      return;
    }

    if (bucket.count >= limit) {
      throw new RateLimitError(
        `rate limit exceeded: ${limit} requests per ${WINDOW_MS / 1000}s`,
      );
    }

    bucket.count += 1;
  });
}
