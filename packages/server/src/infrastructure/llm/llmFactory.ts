import type { Tenant } from "../../config/tenants.js";
import { createClaudeProvider } from "./claudeProvider.js";
import { createGeminiProvider } from "./geminiProvider.js";
import { createOpenAiProvider } from "./openaiProvider.js";
import type { LlmProvider } from "./types.js";

/**
 * Returns the configured LlmProvider for a tenant. The aiService passes
 * `tenant.ai` here; one additional provider is one extra case in this switch.
 * Providers are memoised per-tenant so in-memory spend tracking accumulates
 * across a process lifetime (prototype behaviour — production will persist
 * spend elsewhere).
 */

export interface LlmFactoryOptions {
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

export interface LlmFactory {
  getProvider(tenant: Tenant): LlmProvider;
  clearCache(): void;
}

export function createLlmFactory(options: LlmFactoryOptions = {}): LlmFactory {
  const cache = new Map<string, LlmProvider>();

  function build(tenant: Tenant): LlmProvider {
    const shared = {
      apiKey: tenant.ai.apiKey,
      model: tenant.ai.model,
      dailySpendCapUsd: tenant.ai.dailySpendCapUsd,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      ...(options.now ? { now: options.now } : {}),
    };
    switch (tenant.ai.provider) {
      case "claude":
        return createClaudeProvider(shared);
      case "openai":
        return createOpenAiProvider(shared);
      case "gemini":
        return createGeminiProvider(shared);
      default: {
        const unknown = (tenant.ai as { provider: string }).provider;
        throw new Error(`llmFactory: unknown provider "${unknown}"`);
      }
    }
  }

  return {
    getProvider(tenant: Tenant): LlmProvider {
      const key = `${tenant.tenantId}:${tenant.ai.provider}:${tenant.ai.model}`;
      const cached = cache.get(key);
      if (cached) return cached;
      const provider = build(tenant);
      cache.set(key, provider);
      return provider;
    },
    clearCache() {
      cache.clear();
    },
  };
}
