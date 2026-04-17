import { createSpendTracker, type SpendTracker } from "./spendTracker.js";
import type {
  LlmProvider,
  Message,
  SendMessageOptions,
  SendMessageResult,
  TokenUsage,
} from "./types.js";

/**
 * OpenAI Chat Completions provider. The system prompt is sent as the first
 * message with role "system" — the vendor's dedicated mechanism — and is
 * never interleaved with user content.
 */

const DEFAULT_BASE_URL = "https://api.openai.com";

export interface OpenAiPricing {
  inputPerMTokUsd: number;
  outputPerMTokUsd: number;
}

const DEFAULT_PRICING: OpenAiPricing = {
  inputPerMTokUsd: 2.5,
  outputPerMTokUsd: 10,
};

export interface OpenAiProviderOptions {
  apiKey: string;
  model: string;
  dailySpendCapUsd: number;
  pricing?: OpenAiPricing;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  now?: () => Date;
}

interface OpenAiChatResponse {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export function createOpenAiProvider(options: OpenAiProviderOptions): LlmProvider {
  if (!options.apiKey) throw new Error("openaiProvider: apiKey is required");
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new Error("openaiProvider: fetch unavailable, pass options.fetchImpl");
  }
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  const pricing = options.pricing ?? DEFAULT_PRICING;
  const tracker: SpendTracker = createSpendTracker({
    provider: "openai",
    dailyCapUsd: options.dailySpendCapUsd,
    ...(options.now ? { now: options.now } : {}),
  });
  let totals: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

  return {
    name: "openai",
    model: options.model,

    async sendMessage(opts: SendMessageOptions): Promise<SendMessageResult> {
      tracker.assertWithinCap();
      const body = {
        model: options.model,
        max_tokens: opts.maxOutputTokens ?? 1024,
        messages: [
          { role: "system", content: opts.systemPrompt },
          ...opts.history.map(toOpenAiMessage),
          { role: "user", content: opts.userMessage },
        ],
      };

      const response = await fetchImpl(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${options.apiKey}`,
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`openai api ${response.status}: ${text}`);
      }

      const data = (await response.json()) as OpenAiChatResponse;
      const content = data.choices?.[0]?.message?.content ?? "";

      const promptTokens = data.usage?.prompt_tokens ?? 0;
      const completionTokens = data.usage?.completion_tokens ?? 0;
      const usage: TokenUsage = {
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
      };
      const cost =
        (promptTokens * pricing.inputPerMTokUsd) / 1_000_000 +
        (completionTokens * pricing.outputPerMTokUsd) / 1_000_000;

      totals = {
        promptTokens: totals.promptTokens + usage.promptTokens,
        completionTokens: totals.completionTokens + usage.completionTokens,
        totalTokens: totals.totalTokens + usage.totalTokens,
      };
      tracker.record(cost);

      return { content, usage, estimatedCostUsd: cost };
    },

    getUsage: () => ({ ...totals }),
    getSpendToday: () => tracker.getSpendToday(),
  };
}

function toOpenAiMessage(m: Message): { role: "user" | "assistant"; content: string } {
  return { role: m.role, content: m.content };
}
