import { describe, expect, it, vi } from "vitest";
import type { Tenant } from "../config/tenants.js";
import type { GithubMcpClient } from "../infrastructure/githubClient.js";
import type { IssueCreator } from "../infrastructure/issueCreator.js";
import type { LlmFactory } from "../infrastructure/llm/llmFactory.js";
import type { LlmProvider, SendMessageWithToolsOptions } from "../infrastructure/llm/types.js";
import type { AnalyticsRepository } from "../repositories/analytics.repository.js";
import type { ConversationRepository } from "../repositories/conversation.repository.js";
import type { RepoMapRepository } from "../repositories/repoMap.repository.js";
import { createAiService } from "./aiService.js";
import type { RepoMapService } from "./repoMap.service.js";

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
  const githubClient: GithubMcpClient = {
    searchFiles: vi.fn(async () => []),
    searchIssues: vi.fn(async () => []),
    readFile: vi.fn(),
    getRepo: vi.fn(),
    listDir: vi.fn(),
    getCommitSha: vi.fn(),
    readFileRange: vi.fn(),
  };
  const repoMapService: RepoMapService = {
    build: vi.fn(),
    refresh: vi.fn(),
    renderForScope: vi.fn(async () => {
      calls.push("renderForScope");
      return "## acme/widgets\n### src/a.ts\n- L1-2 function x: x";
    }),
  };
  const repoMapRepository: RepoMapRepository = {
    upsertMap: vi.fn(),
    getMap: vi.fn(async () => null),
    listMapsForTenant: vi.fn(async () => []),
  };
  const issueCreator: IssueCreator = {
    create: vi.fn(async () => ({ url: "https://github.com/acme/widgets/issues/1", number: 1 })),
  };
  const provider: LlmProvider = {
    name: "claude",
    model: "claude-opus-4-7",
    sendMessage: vi.fn(async () => ({
      content: "",
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      estimatedCostUsd: 0,
    })),
    sendMessageWithTools: vi.fn(async () => ({
      content: "answer",
      toolCalls: [],
      stopReason: "end_turn" as const,
      usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
      estimatedCostUsd: 0.01,
    })),
    getUsage: () => ({ promptTokens: 0, completionTokens: 0, totalTokens: 0 }),
    getSpendToday: () => 0,
  };
  const llmFactory: LlmFactory = {
    getProvider: vi.fn(() => provider),
    clearCache: vi.fn(),
  };
  return {
    calls,
    conversationRepo,
    analyticsRepo,
    githubClient,
    repoMapService,
    repoMapRepository,
    issueCreator,
    llmFactory,
    provider,
  };
}

describe("aiService.askQuestion", () => {
  it("orchestrates scope → history → map render → save(agent) → agent loop → save(assistant) → analytics", async () => {
    const deps = makeDeps();
    const service = createAiService(deps);
    const result = await service.askQuestion({
      tenant: makeTenant(),
      sessionId: "550e8400-e29b-41d4-a716-446655440000",
      question: "how does x work?",
    });

    expect(result.answer).toBe("answer");
    expect(result.reposScoped).toEqual(["acme/widgets"]);
    expect(result.reposTouched).toEqual([]);
    expect(result.filesReferenced).toEqual([]);
    expect(deps.calls).toEqual(["getHistory", "renderForScope", "saveMessage:agent", "saveMessage:assistant", "logEvent"]);
  });

  it("threads tenant systemPrompt into the agent loop system slot (not user text)", async () => {
    const deps = makeDeps();
    const service = createAiService(deps);
    await service.askQuestion({
      tenant: makeTenant({ systemPrompt: "TENANT_SYSTEM_XYZ" }),
      sessionId: "550e8400-e29b-41d4-a716-446655440000",
      question: "hi",
    });
    const llmCall = (deps.provider.sendMessageWithTools as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as SendMessageWithToolsOptions;
    expect(llmCall.systemPrompt).toMatch(/TENANT_SYSTEM_XYZ/);
    expect(llmCall.userMessage).toBe("hi");
    expect(llmCall.userMessage).not.toMatch(/TENANT_SYSTEM_XYZ/);
  });

  it("propagates LLM errors and does not save an assistant message", async () => {
    const deps = makeDeps();
    (deps.provider.sendMessageWithTools as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("provider down"),
    );
    const service = createAiService(deps);
    await expect(
      service.askQuestion({
        tenant: makeTenant(),
        sessionId: "550e8400-e29b-41d4-a716-446655440000",
        question: "q",
      }),
    ).rejects.toThrow(/provider down/);
    const roles = (deps.conversationRepo.saveMessage as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => (c[0] as { role: string }).role,
    );
    expect(roles).toEqual(["agent"]);
    expect((deps.analyticsRepo.logEvent as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });

  it("rejects empty question", async () => {
    const deps = makeDeps();
    const service = createAiService(deps);
    await expect(
      service.askQuestion({
        tenant: makeTenant(),
        sessionId: "550e8400-e29b-41d4-a716-446655440000",
        question: "   ",
      }),
    ).rejects.toThrow(/question is required/);
  });

  it("records analytics including toolCallCount and reposScoped metadata", async () => {
    const deps = makeDeps();
    const service = createAiService(deps);
    await service.askQuestion({
      tenant: makeTenant(),
      sessionId: "550e8400-e29b-41d4-a716-446655440000",
      question: "q",
    });
    const logArgs = (deps.analyticsRepo.logEvent as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(logArgs.eventType).toBe("query");
    expect(logArgs.metadata.toolCallCount).toBe(0);
    expect(logArgs.metadata.reposScoped).toEqual(["acme/widgets"]);
  });

  it("passes explicit repoScope into the scope gate", async () => {
    const tenant = makeTenant({
      repos: [
        { owner: "a", name: "x", githubToken: "t1", defaultBranch: "main" },
        { owner: "b", name: "y", githubToken: "t2", defaultBranch: "main" },
      ],
    });
    const deps = makeDeps();
    const service = createAiService(deps);
    const result = await service.askQuestion({
      tenant,
      sessionId: "550e8400-e29b-41d4-a716-446655440000",
      question: "q",
      repoScope: ["b/y"],
    });
    expect(result.reposScoped).toEqual(["b/y"]);
    expect(deps.repoMapService.renderForScope).toHaveBeenCalledWith(tenant, ["b/y"]);
  });
});
