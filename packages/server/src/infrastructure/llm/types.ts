/**
 * Provider-agnostic LLM surface. Every vendor implementation
 * (Claude, OpenAI, Gemini, ...) satisfies this interface so aiService never
 * imports a vendor SDK directly. A new provider added later is one new file
 * here plus one line in the factory — nothing else should change.
 *
 * The system prompt is always passed through the vendor's dedicated system
 * mechanism (never concatenated into a user message). See promptInjection
 * tests in services/ for the structural guarantees enforced against every
 * implementation.
 */

export type MessageRole = "user" | "assistant";

export interface Message {
  role: MessageRole;
  content: string;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface SendMessageOptions {
  systemPrompt: string;
  history: Message[];
  userMessage: string;
  maxOutputTokens?: number;
}

export interface SendMessageResult {
  content: string;
  usage: TokenUsage;
  estimatedCostUsd: number;
}

/**
 * Tool-calling surface. A ToolSpec is the vendor-neutral declaration a
 * provider forwards via its native tool/function mechanism (OpenAI `tools`,
 * Anthropic `tools`, Gemini `functionDeclarations`). A ToolCall is the
 * vendor-neutral decode of a model-requested invocation. A ToolResult is
 * what the caller hands back to the model on the next turn.
 */
export interface ToolSpec {
  name: string;
  description: string;
  jsonSchema: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolResult {
  toolCallId: string;
  name: string;
  content: string;
  isError?: boolean;
}

export interface SendMessageWithToolsOptions {
  systemPrompt: string;
  history: Message[];
  userMessage: string;
  tools: ToolSpec[];
  /**
   * When set, these tool results are appended after `userMessage` as the
   * latest turn so the model can continue from where it requested tools.
   */
  toolResults?: ToolResult[];
  /**
   * Previously-issued tool calls being answered in `toolResults`. Providers
   * that require a matching assistant turn (Anthropic, OpenAI) use these.
   */
  priorToolCalls?: ToolCall[];
  maxOutputTokens?: number;
}

export interface ToolCallingResult {
  /** Final assistant text. Empty string when the model only emitted tool calls. */
  content: string;
  /** Tool calls the model is asking the caller to execute. */
  toolCalls: ToolCall[];
  /**
   * "end_turn" → final answer; "tool_use" → the model wants tools executed
   * and the loop must continue.
   */
  stopReason: "end_turn" | "tool_use" | "max_tokens" | "other";
  usage: TokenUsage;
  estimatedCostUsd: number;
}

export interface LlmProvider {
  readonly name: "claude" | "openai" | "gemini";
  readonly model: string;
  sendMessage(options: SendMessageOptions): Promise<SendMessageResult>;
  sendMessageWithTools(options: SendMessageWithToolsOptions): Promise<ToolCallingResult>;
  getUsage(): TokenUsage;
  getSpendToday(): number;
}

export class SpendCapExceededError extends Error {
  readonly code = "SPEND_CAP_EXCEEDED";
  constructor(public readonly provider: string, public readonly capUsd: number) {
    super(`daily spend cap of $${capUsd} reached for provider ${provider}`);
    this.name = "SpendCapExceededError";
  }
}
