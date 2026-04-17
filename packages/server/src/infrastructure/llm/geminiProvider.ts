import { createSpendTracker, type SpendTracker } from "./spendTracker.js";
import type {
  LlmProvider,
  Message,
  SendMessageOptions,
  SendMessageResult,
  TokenUsage,
} from "./types.js";

/**
 * Google Gemini provider (Generative Language API v1beta). The system prompt
 * is sent via the `systemInstruction` field — the vendor's dedicated system
 * channel — and is never inlined into a user message. Gemini uses `model` as
 * its assistant role, so assistant-authored history messages are translated.
 */

const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com";

export interface GeminiPricing {
  inputPerMTokUsd: number;
  outputPerMTokUsd: number;
}

const DEFAULT_PRICING: GeminiPricing = {
  inputPerMTokUsd: 0.35,
  outputPerMTokUsd: 1.05,
};

export interface GeminiProviderOptions {
  apiKey: string;
  model: string;
  dailySpendCapUsd: number;
  pricing?: GeminiPricing;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  now?: () => Date;
}

interface GeminiResponse {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
}

export function createGeminiProvider(options: GeminiProviderOptions): LlmProvider {
  if (!options.apiKey) throw new Error("geminiProvider: apiKey is required");
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new Error("geminiProvider: fetch unavailable, pass options.fetchImpl");
  }
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  const pricing = options.pricing ?? DEFAULT_PRICING;
  const tracker: SpendTracker = createSpendTracker({
    provider: "gemini",
    dailyCapUsd: options.dailySpendCapUsd,
    ...(options.now ? { now: options.now } : {}),
  });
  let totals: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

  return {
    name: "gemini",
    model: options.model,

    async sendMessage(opts: SendMessageOptions): Promise<SendMessageResult> {
      tracker.assertWithinCap();
      const body = {
        systemInstruction: { parts: [{ text: opts.systemPrompt }] },
        contents: [
          ...opts.history.map(toGeminiContent),
          { role: "user", parts: [{ text: opts.userMessage }] },
        ],
        generationConfig: {
          maxOutputTokens: opts.maxOutputTokens ?? 1024,
        },
      };

      const url = `${baseUrl}/v1beta/models/${encodeURIComponent(options.model)}:generateContent`;
      const response = await fetchImpl(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": options.apiKey,
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`gemini api ${response.status}: ${text}`);
      }

      const data = (await response.json()) as GeminiResponse;
      const content = (data.candidates?.[0]?.content?.parts ?? [])
        .map((p) => p.text ?? "")
        .join("");

      const promptTokens = data.usageMetadata?.promptTokenCount ?? 0;
      const completionTokens = data.usageMetadata?.candidatesTokenCount ?? 0;
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

function toGeminiContent(m: Message): { role: "user" | "model"; parts: [{ text: string }] } {
  return {
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  };
}
