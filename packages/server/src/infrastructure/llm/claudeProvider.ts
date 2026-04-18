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
 * Anthropic Claude provider. Uses the Messages API with the dedicated
 * `system` parameter for the system prompt — never concatenated into a user
 * message (see promptInjection tests). The API key is bound to this
 * instance; the HTTP client is injectable for tests.
 */

const DEFAULT_BASE_URL = "https://api.anthropic.com";
const ANTHROPIC_VERSION = "2023-06-01";

export interface ClaudePricing {
  inputPerMTokUsd: number;
  outputPerMTokUsd: number;
}

const DEFAULT_PRICING: ClaudePricing = {
  inputPerMTokUsd: 3,
  outputPerMTokUsd: 15,
};

export interface ClaudeProviderOptions {
  apiKey: string;
  model: string;
  dailySpendCapUsd: number;
  pricing?: ClaudePricing;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  now?: () => Date;
}

interface ClaudeMessagesResponse {
  content?: Array<{ type?: string; text?: string }>;
  usage?: { input_tokens?: number; output_tokens?: number };
}

export function createClaudeProvider(options: ClaudeProviderOptions): LlmProvider {
  if (!options.apiKey) throw new Error("claudeProvider: apiKey is required");
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new Error("claudeProvider: fetch unavailable, pass options.fetchImpl");
  }
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  const pricing = options.pricing ?? DEFAULT_PRICING;
  const tracker: SpendTracker = createSpendTracker({
    provider: "claude",
    dailyCapUsd: options.dailySpendCapUsd,
    ...(options.now ? { now: options.now } : {}),
  });
  let totals: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

  return {
    name: "claude",
    model: options.model,

    async sendMessage(opts: SendMessageOptions): Promise<SendMessageResult> {
      tracker.assertWithinCap();
      const body = {
        model: options.model,
        max_tokens: opts.maxOutputTokens ?? 1024,
        system: opts.systemPrompt,
        messages: [
          ...opts.history.map(toClaudeMessage),
          { role: "user", content: opts.userMessage },
        ],
      };

      const response = await fetchImpl(`${baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": options.apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`claude api ${response.status}: ${text}`);
      }

      const data = (await response.json()) as ClaudeMessagesResponse;
      const content = (data.content ?? [])
        .filter((b) => b.type === "text" && typeof b.text === "string")
        .map((b) => b.text as string)
        .join("");

      const promptTokens = data.usage?.input_tokens ?? 0;
      const completionTokens = data.usage?.output_tokens ?? 0;
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
        ...opts.history.map(toClaudeMessage),
        { role: "user", content: opts.userMessage },
      ];
      if (opts.priorToolCalls && opts.priorToolCalls.length > 0) {
        messages.push({
          role: "assistant",
          content: opts.priorToolCalls.map((c) => ({
            type: "tool_use",
            id: c.id,
            name: c.name,
            input: c.arguments,
          })),
        });
      }
      if (opts.toolResults && opts.toolResults.length > 0) {
        messages.push({
          role: "user",
          content: opts.toolResults.map((r) => ({
            type: "tool_result",
            tool_use_id: r.toolCallId,
            content: r.content,
            ...(r.isError ? { is_error: true } : {}),
          })),
        });
      }

      const body = {
        model: options.model,
        max_tokens: opts.maxOutputTokens ?? 1024,
        system: opts.systemPrompt,
        messages,
        tools: opts.tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.jsonSchema,
        })),
      };

      const response = await fetchImpl(`${baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": options.apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
        },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const text = await response.text();
        throw new Error(`claude api ${response.status}: ${text}`);
      }
      const data = (await response.json()) as {
        content?: Array<{
          type?: string;
          text?: string;
          id?: string;
          name?: string;
          input?: Record<string, unknown>;
        }>;
        stop_reason?: string;
        usage?: { input_tokens?: number; output_tokens?: number };
      };

      const blocks = data.content ?? [];
      const content = blocks
        .filter((b) => b.type === "text" && typeof b.text === "string")
        .map((b) => b.text as string)
        .join("");
      const toolCalls = blocks
        .filter((b) => b.type === "tool_use" && typeof b.id === "string" && typeof b.name === "string")
        .map((b) => ({
          id: b.id as string,
          name: b.name as string,
          arguments: (b.input ?? {}) as Record<string, unknown>,
        }));

      const stopReason: ToolCallingResult["stopReason"] =
        data.stop_reason === "tool_use"
          ? "tool_use"
          : data.stop_reason === "end_turn"
            ? "end_turn"
            : data.stop_reason === "max_tokens"
              ? "max_tokens"
              : "other";

      const promptTokens = data.usage?.input_tokens ?? 0;
      const completionTokens = data.usage?.output_tokens ?? 0;
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

function toClaudeMessage(m: Message): { role: "user" | "assistant"; content: string } {
  return { role: m.role, content: m.content };
}
