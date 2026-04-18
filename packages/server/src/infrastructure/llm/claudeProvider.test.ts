import { describe, expect, it, vi } from "vitest";
import { createClaudeProvider } from "./claudeProvider.js";
import { SpendCapExceededError } from "./types.js";

function okResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("claudeProvider", () => {
  it("sends the system prompt via the dedicated `system` parameter, not a user message", async () => {
    const fetchImpl = vi.fn(async () =>
      okResponse({
        content: [{ type: "text", text: "hi" }],
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
    );
    const provider = createClaudeProvider({
      apiKey: "sk-test",
      model: "claude-sonnet-4-6",
      dailySpendCapUsd: 10,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await provider.sendMessage({
      systemPrompt: "you are a support assistant",
      history: [
        { role: "user", content: "first" },
        { role: "assistant", content: "reply" },
      ],
      userMessage: "hello",
    });

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.system).toBe("you are a support assistant");
    expect(body.messages.every((m: { role: string }) => m.role !== "system")).toBe(true);
    expect(body.messages[body.messages.length - 1]).toEqual({ role: "user", content: "hello" });
    const headers = init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("sk-test");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
  });

  it("tracks usage and estimates cost from token counts", async () => {
    const fetchImpl = vi.fn(async () =>
      okResponse({
        content: [{ type: "text", text: "ok" }],
        usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 },
      }),
    );
    const provider = createClaudeProvider({
      apiKey: "sk",
      model: "m",
      dailySpendCapUsd: 100,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      pricing: { inputPerMTokUsd: 3, outputPerMTokUsd: 15 },
    });

    const result = await provider.sendMessage({
      systemPrompt: "sp",
      history: [],
      userMessage: "hi",
    });

    expect(result.estimatedCostUsd).toBeCloseTo(18, 5);
    expect(result.usage.totalTokens).toBe(2_000_000);
    expect(provider.getSpendToday()).toBeCloseTo(18, 5);
  });

  it("enforces the daily spend cap before making the HTTP call", async () => {
    const fetchImpl = vi.fn(async () =>
      okResponse({
        content: [{ type: "text", text: "ok" }],
        usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 },
      }),
    );
    const provider = createClaudeProvider({
      apiKey: "sk",
      model: "m",
      dailySpendCapUsd: 5,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await provider.sendMessage({ systemPrompt: "s", history: [], userMessage: "hi" });

    await expect(
      provider.sendMessage({ systemPrompt: "s", history: [], userMessage: "again" }),
    ).rejects.toBeInstanceOf(SpendCapExceededError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("sendMessageWithTools forwards tools and decodes tool_use blocks", async () => {
    const fetchImpl = vi.fn(async () =>
      okResponse({
        content: [
          { type: "text", text: "thinking" },
          { type: "tool_use", id: "tu_1", name: "readFile", input: { path: "a.ts" } },
        ],
        stop_reason: "tool_use",
        usage: { input_tokens: 5, output_tokens: 5 },
      }),
    );
    const provider = createClaudeProvider({
      apiKey: "sk",
      model: "claude-sonnet-4-6",
      dailySpendCapUsd: 10,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const result = await provider.sendMessageWithTools({
      systemPrompt: "s",
      history: [],
      userMessage: "u",
      tools: [
        {
          name: "readFile",
          description: "read",
          jsonSchema: { type: "object", properties: { path: { type: "string" } } },
        },
      ],
    });

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.tools[0]).toEqual({
      name: "readFile",
      description: "read",
      input_schema: { type: "object", properties: { path: { type: "string" } } },
    });
    expect(body.system).toBe("s");
    expect(result.stopReason).toBe("tool_use");
    expect(result.toolCalls).toEqual([
      { id: "tu_1", name: "readFile", arguments: { path: "a.ts" } },
    ]);
    expect(result.content).toBe("thinking");
  });

  it("sendMessageWithTools enforces spend cap", async () => {
    const fetchImpl = vi.fn(async () =>
      okResponse({
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 },
      }),
    );
    const provider = createClaudeProvider({
      apiKey: "sk",
      model: "m",
      dailySpendCapUsd: 5,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await provider.sendMessageWithTools({
      systemPrompt: "s",
      history: [],
      userMessage: "u",
      tools: [],
    });
    await expect(
      provider.sendMessageWithTools({
        systemPrompt: "s",
        history: [],
        userMessage: "u",
        tools: [],
      }),
    ).rejects.toBeInstanceOf(SpendCapExceededError);
  });

  it("throws on non-2xx responses", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("boom", { status: 500, statusText: "ISE" }),
    );
    const provider = createClaudeProvider({
      apiKey: "sk",
      model: "m",
      dailySpendCapUsd: 10,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(
      provider.sendMessage({ systemPrompt: "s", history: [], userMessage: "hi" }),
    ).rejects.toThrow(/claude api 500/);
  });
});
