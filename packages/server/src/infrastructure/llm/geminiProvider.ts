import { createSpendTracker, type SpendTracker } from "./spendTracker.js";
import type {
  LlmProvider,
  Message,
  SendMessageOptions,
  SendMessageResult,
  SendMessageWithToolsOptions,
  ToolCallingResult,
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

    async sendMessageWithTools(opts: SendMessageWithToolsOptions): Promise<ToolCallingResult> {
      tracker.assertWithinCap();
      const contents: Array<Record<string, unknown>> = [
        ...opts.history.map(toGeminiContent),
        { role: "user", parts: [{ text: opts.userMessage }] },
      ];
      if (opts.priorToolCalls && opts.priorToolCalls.length > 0) {
        contents.push({
          role: "model",
          parts: opts.priorToolCalls.map((c) => ({
            functionCall: { name: c.name, args: c.arguments },
          })),
        });
      }
      if (opts.toolResults && opts.toolResults.length > 0) {
        contents.push({
          role: "user",
          parts: opts.toolResults.map((r) => ({
            functionResponse: {
              name: r.name,
              response: r.isError ? { error: r.content } : { content: r.content },
            },
          })),
        });
      }

      const body = {
        systemInstruction: { parts: [{ text: opts.systemPrompt }] },
        contents,
        tools: [
          {
            functionDeclarations: opts.tools.map((t) => ({
              name: t.name,
              description: t.description,
              parameters: t.jsonSchema,
            })),
          },
        ],
        generationConfig: { maxOutputTokens: opts.maxOutputTokens ?? 1024 },
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
      const data = (await response.json()) as {
        candidates?: Array<{
          content?: {
            parts?: Array<{
              text?: string;
              functionCall?: { name?: string; args?: Record<string, unknown> };
            }>;
          };
          finishReason?: string;
        }>;
        usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
      };

      const candidate = data.candidates?.[0];
      const parts = candidate?.content?.parts ?? [];
      const content = parts.map((p) => p.text ?? "").join("");
      let callIdx = 0;
      const toolCalls = parts
        .filter((p) => p.functionCall && typeof p.functionCall.name === "string")
        .map((p) => {
          callIdx += 1;
          return {
            id: `gem_${callIdx}`,
            name: p.functionCall?.name as string,
            arguments: (p.functionCall?.args ?? {}) as Record<string, unknown>,
          };
        });

      const stopReason: ToolCallingResult["stopReason"] =
        toolCalls.length > 0
          ? "tool_use"
          : candidate?.finishReason === "MAX_TOKENS"
            ? "max_tokens"
            : candidate?.finishReason === "STOP"
              ? "end_turn"
              : "other";

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

      return { content, toolCalls, stopReason, usage, estimatedCostUsd: cost };
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
