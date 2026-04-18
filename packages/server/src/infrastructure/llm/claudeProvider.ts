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
        throw new Error(`claude api ${response.status}: ${sanitiseUpstreamError(text)}`);
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
      // Replay every prior (tool_use → tool_result) pair in order, so the
      // Claude transcript stays coherent across multi-turn tool conversations.
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
            content: t.toolCalls.map((c) => ({
              type: "tool_use",
              id: c.id,
              name: c.name,
              input: c.arguments,
            })),
          });
        }
        if (t.toolResults && t.toolResults.length > 0) {
          messages.push({
            role: "user",
            content: t.toolResults.map((r) => ({
              type: "tool_result",
              tool_use_id: r.toolCallId,
              content: r.content,
              ...(r.isError ? { is_error: true } : {}),
            })),
          });
        }
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
        throw new Error(`claude api ${response.status}: ${sanitiseUpstreamError(text)}`);
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

/**
 * Truncate upstream error bodies and strip echoed auth headers before
 * embedding them in thrown Error messages / logs.
 */
function sanitiseUpstreamError(body: string): string {
  const MAX = 500;
  const truncated = body.length > MAX ? `${body.slice(0, MAX)}…[truncated]` : body;
  return truncated
    .replace(/Bearer\s+[A-Za-z0-9._\-]+/g, "Bearer [redacted]")
    .replace(/(["']?authorization["']?\s*[:=]\s*["']?)[^"'\s,}]+(\s+[A-Za-z0-9._\-]+)?/gi, "$1[redacted]")
    .replace(/(["']?x-api-key["']?\s*[:=]\s*["']?)[^"'\s,}]+/gi, "$1[redacted]")
    .replace(/(["']?api[-_]?key["']?\s*[:=]\s*["']?)[^"'\s,}]+/gi, "$1[redacted]");
}
