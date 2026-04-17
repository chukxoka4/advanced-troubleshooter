import { describe, expect, it } from "vitest";
import { SpendCapExceededError, type LlmProvider, type Message } from "./types.js";

describe("llm types", () => {
  it("SpendCapExceededError exposes the provider name and cap", () => {
    const err = new SpendCapExceededError("claude", 50);
    expect(err.code).toBe("SPEND_CAP_EXCEEDED");
    expect(err.provider).toBe("claude");
    expect(err.capUsd).toBe(50);
    expect(err.message).toMatch(/\$50/);
    expect(err).toBeInstanceOf(Error);
  });

  it("LlmProvider shape accepts a minimal implementation", async () => {
    const history: Message[] = [{ role: "user", content: "hello" }];
    const stub: LlmProvider = {
      name: "claude",
      model: "claude-sonnet-4-6",
      async sendMessage({ userMessage }) {
        return {
          content: `echo:${userMessage}`,
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          estimatedCostUsd: 0.001,
        };
      },
      getUsage: () => ({ promptTokens: 0, completionTokens: 0, totalTokens: 0 }),
      getSpendToday: () => 0,
    };
    const result = await stub.sendMessage({
      systemPrompt: "sp",
      history,
      userMessage: "hi",
    });
    expect(result.content).toBe("echo:hi");
    expect(result.usage.totalTokens).toBe(2);
  });
});
