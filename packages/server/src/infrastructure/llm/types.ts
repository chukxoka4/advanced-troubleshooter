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

export interface LlmProvider {
  readonly name: "claude" | "openai" | "gemini";
  readonly model: string;
  sendMessage(options: SendMessageOptions): Promise<SendMessageResult>;
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
