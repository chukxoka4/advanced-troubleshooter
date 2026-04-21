import { describe, expect, it, vi } from "vitest";
import { createOpenAiProvider } from "./openaiProvider.js";
import { SpendCapExceededError } from "./types.js";

function okResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("openaiProvider", () => {
  it("puts the system prompt first with role=system and never mixes it with user content", async () => {
    const fetchImpl = vi.fn(async () =>
      okResponse({
        choices: [{ message: { content: "ok" } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
    );
    const provider = createOpenAiProvider({
      apiKey: "sk-test",
      model: "gpt-4o",
      dailySpendCapUsd: 10,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await provider.sendMessage({
      systemPrompt: "you are careful",
      history: [{ role: "assistant", content: "hi" }],
      userMessage: "help",
    });

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/v1/chat/completions");
    const body = JSON.parse(init.body as string);
    expect(body.messages[0]).toEqual({ role: "system", content: "you are careful" });
    const systemCount = body.messages.filter((m: { role: string }) => m.role === "system").length;
    expect(systemCount).toBe(1);
    expect(body.messages[body.messages.length - 1]).toEqual({ role: "user", content: "help" });
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer sk-test");
  });

  it("enforces the daily spend cap", async () => {
    const fetchImpl = vi.fn(async () =>
      okResponse({
        choices: [{ message: { content: "ok" } }],
        usage: { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 },
      }),
    );
    const provider = createOpenAiProvider({
      apiKey: "sk",
      model: "gpt-4o",
      dailySpendCapUsd: 5,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await provider.sendMessage({ systemPrompt: "s", history: [], userMessage: "hi" });
    await expect(
      provider.sendMessage({ systemPrompt: "s", history: [], userMessage: "again" }),
    ).rejects.toBeInstanceOf(SpendCapExceededError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("sendMessageWithTools forwards tool schema and decodes tool_calls", async () => {
    const fetchImpl = vi.fn(async () =>
      okResponse({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: { name: "readFile", arguments: '{"path":"a.ts"}' },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 5 },
      }),
    );
    const provider = createOpenAiProvider({
      apiKey: "sk",
      model: "gpt-4o",
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
    expect(body.tools[0].function.name).toBe("readFile");
    expect(body.tools[0].function.parameters).toEqual({
      type: "object",
      properties: { path: { type: "string" } },
    });
    expect(result.stopReason).toBe("tool_use");
    expect(result.toolCalls).toEqual([
      { id: "call_1", name: "readFile", arguments: { path: "a.ts" } },
    ]);
  });

  it("sendMessageWithTools sets tool_choice required when opts.toolChoice is required", async () => {
    const fetchImpl = vi.fn(async () =>
      okResponse({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: "c1",
                  type: "function",
                  function: { name: "readFile", arguments: "{}" },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
    );
    const provider = createOpenAiProvider({
      apiKey: "sk",
      model: "gpt-4o",
      dailySpendCapUsd: 10,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await provider.sendMessageWithTools({
      systemPrompt: "s",
      history: [],
      userMessage: "u",
      tools: [{ name: "readFile", description: "d", jsonSchema: { type: "object" } }],
      toolChoice: "required",
    });
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string).tool_choice).toBe("required");
  });

  it("sendMessageWithTools enforces spend cap", async () => {
    const fetchImpl = vi.fn(async () =>
      okResponse({
        choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 },
      }),
    );
    const provider = createOpenAiProvider({
      apiKey: "sk",
      model: "gpt-4o",
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
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 429 }));
    const provider = createOpenAiProvider({
      apiKey: "sk",
      model: "gpt-4o",
      dailySpendCapUsd: 10,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(
      provider.sendMessage({ systemPrompt: "s", history: [], userMessage: "hi" }),
    ).rejects.toThrow(/openai api 429/);
  });

  it("sanitises upstream error bodies (truncates + redacts echoed credentials)", async () => {
    const huge = "x".repeat(2000);
    const body = `Authorization: Bearer sk-real-secret-123 api_key: "sk-another" ${huge}`;
    const fetchImpl = vi.fn(async () => new Response(body, { status: 400 }));
    const provider = createOpenAiProvider({
      apiKey: "sk-live",
      model: "gpt-4o",
      dailySpendCapUsd: 10,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    let err: Error | undefined;
    try {
      await provider.sendMessage({ systemPrompt: "s", history: [], userMessage: "hi" });
    } catch (e) {
      err = e as Error;
    }
    expect(err).toBeDefined();
    const msg = err?.message ?? "";
    expect(msg).not.toContain("sk-real-secret-123");
    expect(msg).not.toContain("sk-another");
    expect(msg).toContain("[redacted]");
    expect(msg).toContain("[truncated]");
    // Whole message stays bounded.
    expect(msg.length).toBeLessThan(700);
  });
});
