import { describe, expect, it, vi } from "vitest";
import { createGeminiProvider } from "./geminiProvider.js";
import { SpendCapExceededError } from "./types.js";

function okResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("geminiProvider", () => {
  it("sends the system prompt via systemInstruction, translates assistant→model", async () => {
    const fetchImpl = vi.fn(async () =>
      okResponse({
        candidates: [{ content: { parts: [{ text: "ok" }] } }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
      }),
    );
    const provider = createGeminiProvider({
      apiKey: "key",
      model: "gemini-1.5-pro",
      dailySpendCapUsd: 10,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await provider.sendMessage({
      systemPrompt: "be helpful",
      history: [{ role: "assistant", content: "prior" }],
      userMessage: "hi",
    });

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/v1beta/models/gemini-1.5-pro:generateContent");
    const body = JSON.parse(init.body as string);
    expect(body.systemInstruction.parts[0].text).toBe("be helpful");
    const roles = body.contents.map((c: { role: string }) => c.role);
    expect(roles).toEqual(["model", "user"]);
    expect(roles).not.toContain("system");
    const headers = init.headers as Record<string, string>;
    expect(headers["x-goog-api-key"]).toBe("key");
  });

  it("enforces the daily spend cap", async () => {
    const fetchImpl = vi.fn(async () =>
      okResponse({
        candidates: [{ content: { parts: [{ text: "ok" }] } }],
        usageMetadata: { promptTokenCount: 5_000_000, candidatesTokenCount: 5_000_000 },
      }),
    );
    const provider = createGeminiProvider({
      apiKey: "k",
      model: "gemini",
      dailySpendCapUsd: 2,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await provider.sendMessage({ systemPrompt: "s", history: [], userMessage: "hi" });
    await expect(
      provider.sendMessage({ systemPrompt: "s", history: [], userMessage: "again" }),
    ).rejects.toBeInstanceOf(SpendCapExceededError);
  });

  it("sendMessageWithTools forwards functionDeclarations and decodes functionCall", async () => {
    const fetchImpl = vi.fn(async () =>
      okResponse({
        candidates: [
          {
            content: {
              parts: [
                { functionCall: { name: "readFile", args: { path: "a.ts" } } },
              ],
            },
            finishReason: "STOP",
          },
        ],
        usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 3 },
      }),
    );
    const provider = createGeminiProvider({
      apiKey: "k",
      model: "gemini-1.5-pro",
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
    expect(body.tools[0].functionDeclarations[0].name).toBe("readFile");
    expect(result.stopReason).toBe("tool_use");
    expect(result.toolCalls[0]).toMatchObject({ name: "readFile", arguments: { path: "a.ts" } });
  });

  it("sendMessageWithTools enforces spend cap", async () => {
    const fetchImpl = vi.fn(async () =>
      okResponse({
        candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 5_000_000, candidatesTokenCount: 5_000_000 },
      }),
    );
    const provider = createGeminiProvider({
      apiKey: "k",
      model: "gemini",
      dailySpendCapUsd: 2,
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

  it("throws on non-2xx", async () => {
    const fetchImpl = vi.fn(async () => new Response("boom", { status: 400 }));
    const provider = createGeminiProvider({
      apiKey: "k",
      model: "gemini",
      dailySpendCapUsd: 10,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(
      provider.sendMessage({ systemPrompt: "s", history: [], userMessage: "hi" }),
    ).rejects.toThrow(/gemini api 400/);
  });
});
