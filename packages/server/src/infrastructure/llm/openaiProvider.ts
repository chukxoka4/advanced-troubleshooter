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

    async sendMessageWithTools(opts: SendMessageWithToolsOptions): Promise<ToolCallingResult> {
      tracker.assertWithinCap();
      const messages: Array<Record<string, unknown>> = [
        { role: "system", content: opts.systemPrompt },
        ...opts.history.map(toOpenAiMessage),
        { role: "user", content: opts.userMessage },
      ];
      // Replay every prior (assistant-tool_calls → tool-results) pair in
      // order. OpenAI requires every `tool` message to follow its matching
      // `assistant.tool_calls`; dropping earlier pairs in a multi-turn
      // conversation produces a 400 from the API.
      const turns: Array<{ toolCalls: typeof opts.priorToolCalls; toolResults: typeof opts.toolResults }> = [];
      if (opts.priorToolTurns && opts.priorToolTurns.length > 0) {
        for (const t of opts.priorToolTurns) {
          turns.push({ toolCalls: t.toolCalls, toolResults: t.toolResults });
        }
      } else if (
        (opts.priorToolCalls && opts.priorToolCalls.length > 0) ||
        (opts.toolResults && opts.toolResults.length > 0)
      ) {
        turns.push({ toolCalls: opts.priorToolCalls, toolResults: opts.toolResults });
      }
      for (const t of turns) {
        if (t.toolCalls && t.toolCalls.length > 0) {
          messages.push({
            role: "assistant",
            content: null,
            tool_calls: t.toolCalls.map((c) => ({
              id: c.id,
              type: "function",
              function: { name: c.name, arguments: JSON.stringify(c.arguments) },
            })),
          });
        }
        if (t.toolResults && t.toolResults.length > 0) {
          for (const r of t.toolResults) {
            messages.push({
              role: "tool",
              tool_call_id: r.toolCallId,
              content: r.content,
            });
          }
        }
      }

      const body = {
        model: options.model,
        max_tokens: opts.maxOutputTokens ?? 1024,
        messages,
        tools: opts.tools.map((t) => ({
          type: "function",
          function: { name: t.name, description: t.description, parameters: t.jsonSchema },
        })),
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
      const data = (await response.json()) as {
        choices?: Array<{
          message?: {
            content?: string | null;
            tool_calls?: Array<{
              id?: string;
              function?: { name?: string; arguments?: string };
            }>;
          };
          finish_reason?: string;
        }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };

      const choice = data.choices?.[0];
      const content = choice?.message?.content ?? "";
      const rawToolCalls = choice?.message?.tool_calls ?? [];
      const toolCalls = rawToolCalls
        .filter((tc) => typeof tc.id === "string" && typeof tc.function?.name === "string")
        .map((tc) => {
          let args: Record<string, unknown> = {};
          try {
            args = tc.function?.arguments ? (JSON.parse(tc.function.arguments) as Record<string, unknown>) : {};
          } catch {
            args = {};
          }
          return {
            id: tc.id as string,
            name: tc.function?.name as string,
            arguments: args,
          };
        });

      const finish = choice?.finish_reason;
      const stopReason: ToolCallingResult["stopReason"] =
        finish === "tool_calls" || toolCalls.length > 0
          ? "tool_use"
          : finish === "length"
            ? "max_tokens"
            : finish === "stop"
              ? "end_turn"
              : "other";

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

      return { content: content ?? "", toolCalls, stopReason, usage, estimatedCostUsd: cost };
    },

    getUsage: () => ({ ...totals }),
    getSpendToday: () => tracker.getSpendToday(),
  };
}

function toOpenAiMessage(m: Message): { role: "user" | "assistant"; content: string } {
  return { role: m.role, content: m.content };
}
