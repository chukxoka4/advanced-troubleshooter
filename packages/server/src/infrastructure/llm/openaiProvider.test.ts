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
});
