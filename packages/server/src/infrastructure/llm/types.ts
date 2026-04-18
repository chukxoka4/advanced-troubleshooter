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

/**
 * A single round-trip of (assistant-requested calls → caller-supplied results).
 * Used to preserve the FULL multi-turn tool-use history across provider
 * invocations so OpenAI's contract (each `tool` message must follow its
 * matching `assistant.tool_calls`) is never violated by dropping earlier
 * pairs. Claude and Gemini also iterate these turns so their transcript
 * stays consistent with the real conversation.
 */
export interface ToolTurn {
  toolCalls: ToolCall[];
  toolResults: ToolResult[];
}

export interface SendMessageWithToolsOptions {
  systemPrompt: string;
  history: Message[];
  userMessage: string;
  tools: ToolSpec[];
  /**
   * Full ordered history of previous (assistant-tool_calls → tool-results)
   * pairs for this conversation. Providers replay these in order so no pair
   * is ever dropped — required for OpenAI's strict tool-message ordering.
   */
  priorToolTurns?: ToolTurn[];
  /**
   * @deprecated Use priorToolTurns. Kept for back-compat with a single
   * pending turn: equivalent to one ToolTurn appended at the end.
   */
  toolResults?: ToolResult[];
  /** @deprecated Use priorToolTurns. */
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
