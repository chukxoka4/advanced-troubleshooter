import { describe, expect, it, vi } from "vitest";
import type { Tenant } from "../config/tenants.js";
import type { GithubMcpClient } from "../infrastructure/githubClient.js";
import type { LlmFactory } from "../infrastructure/llm/llmFactory.js";
import type { LlmProvider, SendMessageOptions } from "../infrastructure/llm/types.js";
import type { AnalyticsRepository } from "../repositories/analytics.repository.js";
import type { ConversationRepository } from "../repositories/conversation.repository.js";
import { createAiService } from "./aiService.js";

function makeTenant(overrides: Partial<Tenant> = {}): Tenant {
  return {
    tenantId: "team-alpha",
    displayName: "Alpha",
    repos: [
      {
        owner: "acme",
        name: "widgets",
        githubToken: "ghs_test",
        defaultBranch: "main",
      },
    ],
    ai: {
      provider: "claude",
      model: "claude-opus-4-7",
      apiKey: "sk-test",
      dailySpendCapUsd: 5,
    },
    systemPrompt: "You answer support questions using the given repo context.",
    allowedOrigins: [],
    allowedUsers: [],
    rateLimits: { questionsPerMinute: 60, issuesPerHour: 30 },
    ...overrides,
  } as Tenant;
}

function makeDeps() {
  const calls: string[] = [];
  const sentSystemPrompts: string[] = [];
  const conversationRepo: ConversationRepository = {
    getHistory: vi.fn(async () => {
      calls.push("getHistory");
      return [];
    }),
    saveMessage: vi.fn(async (input) => {
      calls.push(`saveMessage:${input.role}`);
      return {
        id: input.role,
        tenantId: input.tenantId,
        sessionId: input.sessionId,
        role: input.role,
        message: input.message,
        reposSearched: input.reposSearched ?? [],
        filesReferenced: input.filesReferenced ?? [],
        createdAt: new Date(),
      };
    }),
  };
  const analyticsRepo: AnalyticsRepository = {
    logEvent: vi.fn(async () => {
      calls.push("logEvent");
    }),
  };
  const githubMcp: GithubMcpClient = {
    searchFiles: vi.fn(async () => {
      calls.push("search");
      return [
        { repo: "acme/widgets", path: "src/a.ts", url: "u" },
      ];
    }),
    readFile: vi.fn(async () => {
      calls.push("read");
      return {
        repo: "acme/widgets",
        path: "src/a.ts",
        ref: "main",
        content: "export const x = 1;",
      };
    }),
  };
  const provider: LlmProvider = {
    name: "claude",
    model: "claude-opus-4-7",
    sendMessage: vi.fn(async (opts: SendMessageOptions) => {
      calls.push("llm");
      sentSystemPrompts.push(opts.systemPrompt);
      return {
        content: "answer",
        usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
        estimatedCostUsd: 0.01,
      };
    }),
    getUsage: () => ({ promptTokens: 0, completionTokens: 0, totalTokens: 0 }),
    getSpendToday: () => 0,
  };
  const llmFactory: LlmFactory = {
    getProvider: vi.fn(() => provider),
    clearCache: vi.fn(),
  };
  return { calls, sentSystemPrompts, conversationRepo, analyticsRepo, githubMcp, llmFactory, provider };
}

describe("aiService.askQuestion", () => {
  it("orchestrates history → search → read → save(agent) → llm → save(assistant) → log", async () => {
    const deps = makeDeps();
    const service = createAiService(deps);
    const result = await service.askQuestion({
      tenant: makeTenant(),
      sessionId: "s1",
      question: "how does x work?",
    });

    expect(result.answer).toBe("answer");
    expect(result.reposSearched).toEqual(["acme/widgets"]);
    expect(result.filesReferenced).toEqual(["acme/widgets:src/a.ts"]);
    expect(deps.calls).toEqual([
      "getHistory",
      "search",
      "read",
      "saveMessage:agent",
      "llm",
      "saveMessage:assistant",
      "logEvent",
    ]);
  });

  it("passes the tenant systemPrompt through the LLM system parameter (never in user text)", async () => {
    const deps = makeDeps();
    const service = createAiService(deps);
    await service.askQuestion({
      tenant: makeTenant({ systemPrompt: "TENANT_SYSTEM_XYZ" }),
      sessionId: "s1",
      question: "hi",
    });
    expect(deps.sentSystemPrompts[0]).toMatch(/TENANT_SYSTEM_XYZ/);
    const llmCall = (deps.provider.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as SendMessageOptions;
    expect(llmCall.userMessage).toBe("hi");
    expect(llmCall.userMessage).not.toMatch(/TENANT_SYSTEM_XYZ/);
  });

  it("propagates LLM errors and does not save an assistant message", async () => {
    const deps = makeDeps();
    (deps.provider.sendMessage as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("provider down"),
    );
    const service = createAiService(deps);
    await expect(
      service.askQuestion({ tenant: makeTenant(), sessionId: "s1", question: "q" }),
    ).rejects.toThrow(/provider down/);
    const roles = (deps.conversationRepo.saveMessage as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => (c[0] as { role: string }).role);
    expect(roles).toEqual(["agent"]);
    expect((deps.analyticsRepo.logEvent as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });

  it("rejects empty question", async () => {
    const deps = makeDeps();
    const service = createAiService(deps);
    await expect(
      service.askQuestion({ tenant: makeTenant(), sessionId: "s1", question: "   " }),
    ).rejects.toThrow(/question is required/);
  });

  it("records analytics with provider name in metadata", async () => {
    const deps = makeDeps();
    const service = createAiService(deps);
    await service.askQuestion({ tenant: makeTenant(), sessionId: "s1", question: "q" });
    const logArgs = (deps.analyticsRepo.logEvent as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(logArgs.eventType).toBe("query");
    expect(logArgs.reposCount).toBe(1);
    expect(logArgs.metadata.provider).toBe("claude");
  });

  it("completes with empty reposSearched/filesReferenced when every search returns no hits", async () => {
    // Reproduces the common real-world case where GitHub's code-search
    // index has not covered a tenant's repos (selective indexing for
    // low-activity accounts). The service must still hand a valid
    // response back to the route layer rather than throwing — the LLM
    // will answer with whatever context the system prompt alone provides.
    const deps = makeDeps();
    (deps.githubMcp.searchFiles as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    const service = createAiService(deps);

    const result = await service.askQuestion({
      tenant: makeTenant(),
      sessionId: "s1",
      question: "anything",
    });

    expect(result.reposSearched).toEqual([]);
    expect(result.filesReferenced).toEqual([]);
    expect(result.answer).toBe("answer");
    // The empty-grounding path must: still hit search (exactly once per
    // tenant repo), never read any file, still produce an LLM call, still
    // persist agent+assistant messages, and still log exactly one
    // analytics event. Empty hits is a valid state, not an error state.
    expect(deps.githubMcp.searchFiles).toHaveBeenCalledTimes(1);
    expect(deps.githubMcp.readFile).not.toHaveBeenCalled();
    expect(deps.provider.sendMessage).toHaveBeenCalledTimes(1);
    expect(deps.conversationRepo.saveMessage).toHaveBeenCalledTimes(2);
    const savedRoles = (deps.conversationRepo.saveMessage as ReturnType<typeof vi.fn>)
      .mock.calls.map((c) => (c[0] as { role: string }).role);
    expect(savedRoles).toEqual(["agent", "assistant"]);
    expect(deps.analyticsRepo.logEvent).toHaveBeenCalledTimes(1);
  });
});
