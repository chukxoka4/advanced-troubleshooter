import { describe, expect, it, vi } from "vitest";
import type { Tenant } from "../config/tenants.js";
import type { GithubMcpClient } from "../infrastructure/githubClient.js";
import type {
  LlmProvider,
  SendMessageWithToolsOptions,
  ToolCall,
  ToolCallingResult,
} from "../infrastructure/llm/types.js";
import type { RepoMapRepository } from "../repositories/repoMap.repository.js";
import type { TenantRepo } from "./repoScope.service.js";
import { createAgentLoop } from "./agentLoop.service.js";
import type { ToolDefinition } from "./tools/types.js";

const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

function makeRepo(owner = "acme", name = "a"): TenantRepo {
  return { owner, name, githubToken: "tk", defaultBranch: "main" };
}

function makeTenant(): Tenant {
  return {
    tenantId: "t",
    displayName: "T",
    repos: [makeRepo()],
    ai: {
      provider: "openai",
      model: "gpt-4o",
      apiKey: "sk",
      dailySpendCapUsd: 10,
    },
    systemPrompt: "s",
    allowedOrigins: [],
    allowedUsers: [],
    rateLimits: { questionsPerMinute: 1, issuesPerHour: 1 },
  } as Tenant;
}

function tc(id: string, name: string, args: Record<string, unknown>): ToolCall {
  return { id, name, arguments: args };
}

function providerScript(responses: ToolCallingResult[]): {
  provider: LlmProvider;
  sendMessageWithTools: ReturnType<typeof vi.fn>;
} {
  const sendMessageWithTools = vi.fn(async (_opts: SendMessageWithToolsOptions) => {
    const next = responses.shift();
    if (!next) throw new Error("unexpected extra LLM turn");
    return next;
  });
  const provider: LlmProvider = {
    name: "openai",
    model: "gpt-4o",
    sendMessage: vi.fn(async () => ({
      content: "",
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      estimatedCostUsd: 0,
    })),
    sendMessageWithTools: sendMessageWithTools as unknown as LlmProvider["sendMessageWithTools"],
    getUsage: () => ({ promptTokens: 0, completionTokens: 0, totalTokens: 0 }),
    getSpendToday: () => 0,
  };
  return { provider, sendMessageWithTools };
}

const noopGithub: GithubMcpClient = {} as GithubMcpClient;
const noopRepoMaps: RepoMapRepository = {} as RepoMapRepository;

function makeLoop(provider: LlmProvider) {
  return createAgentLoop({
    provider,
    githubClient: noopGithub,
    repoMapRepository: noopRepoMaps,
    logger: silentLogger,
  });
}

describe("agentLoop.service", () => {
  it("respects maxTurns (stops asking provider after the cap)", async () => {
    const alwaysToolUse = (): ToolCallingResult => ({
      content: "",
      toolCalls: [tc(`c-${Math.random()}`, "mock", { repo: "acme/a" })],
      stopReason: "tool_use",
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      estimatedCostUsd: 0.001,
    });
    const { provider, sendMessageWithTools } = providerScript([
      alwaysToolUse(),
      alwaysToolUse(),
      alwaysToolUse(),
    ]);
    const tool: ToolDefinition = {
      name: "mock",
      description: "",
      jsonSchema: {},
      execute: async () => "ok",
    };
    const loop = makeLoop(provider);
    await loop.run({
      tenant: makeTenant(),
      allowedRepos: [makeRepo()],
      history: [],
      systemPrompt: "s",
      userMessage: "u",
      tools: [tool],
      maxTurns: 3,
    });
    expect(sendMessageWithTools).toHaveBeenCalledTimes(3);
  });

  it("dispatcher rejects out-of-scope repo arg; tool is NEVER called", async () => {
    const execute = vi.fn(async () => "should not run");
    const tool: ToolDefinition = {
      name: "readFile",
      description: "",
      jsonSchema: {},
      execute,
    };
    const { provider, sendMessageWithTools } = providerScript([
      {
        content: "",
        toolCalls: [tc("c1", "readFile", { repo: "attacker/x", path: "a.ts" })],
        stopReason: "tool_use",
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        estimatedCostUsd: 0,
      },
      {
        content: "final",
        toolCalls: [],
        stopReason: "end_turn",
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        estimatedCostUsd: 0,
      },
    ]);
    const loop = makeLoop(provider);
    const result = await loop.run({
      tenant: makeTenant(),
      allowedRepos: [makeRepo()],
      history: [],
      systemPrompt: "s",
      userMessage: "u",
      tools: [tool],
    });
    expect(execute).not.toHaveBeenCalled();
    expect(result.answer).toBe("final");
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]?.ok).toBe(false);
    expect(result.toolCalls[0]?.errorMessage).toBe("repo not in tenant scope");
    // And the tool-result the provider saw was the scope error:
    const secondCall = sendMessageWithTools.mock.calls[1]?.[0] as SendMessageWithToolsOptions;
    expect(secondCall.toolResults?.[0]?.isError).toBe(true);
    expect(secondCall.toolResults?.[0]?.content).toContain("repo not in tenant scope");
  });

  it("collects filesReferenced from successful readFile calls (deduped)", async () => {
    const tool: ToolDefinition = {
      name: "readFile",
      description: "",
      jsonSchema: {},
      execute: async () => "file contents",
    };
    const { provider } = providerScript([
      {
        content: "",
        toolCalls: [
          tc("c1", "readFile", { repo: "acme/a", path: "x.ts" }),
          tc("c2", "readFile", { repo: "acme/a", path: "y.ts" }),
          tc("c3", "readFile", { repo: "acme/a", path: "x.ts" }),
        ],
        stopReason: "tool_use",
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        estimatedCostUsd: 0,
      },
      {
        content: "done",
        toolCalls: [],
        stopReason: "end_turn",
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        estimatedCostUsd: 0,
      },
    ]);
    const result = await makeLoop(provider).run({
      tenant: makeTenant(),
      allowedRepos: [makeRepo()],
      history: [],
      systemPrompt: "s",
      userMessage: "u",
      tools: [tool],
    });
    expect(result.filesReferenced).toEqual(["acme/a:x.ts", "acme/a:y.ts"]);
  });

  it("propagates provider errors (does not swallow)", async () => {
    const provider: LlmProvider = {
      name: "openai",
      model: "m",
      sendMessage: vi.fn(),
      sendMessageWithTools: vi.fn(async () => {
        throw new Error("boom");
      }) as unknown as LlmProvider["sendMessageWithTools"],
      getUsage: () => ({ promptTokens: 0, completionTokens: 0, totalTokens: 0 }),
      getSpendToday: () => 0,
    };
    await expect(
      makeLoop(provider).run({
        tenant: makeTenant(),
        allowedRepos: [makeRepo()],
        history: [],
        systemPrompt: "s",
        userMessage: "u",
        tools: [],
      }),
    ).rejects.toThrow(/boom/);
  });

  it("wraps every successful tool output in <untrusted_tool_output> before handing back to provider", async () => {
    const tools: ToolDefinition[] = [
      { name: "readFile", description: "", jsonSchema: {}, execute: async () => "file body" },
      { name: "searchCode", description: "", jsonSchema: {}, execute: async () => "- acme/a: x.ts" },
      { name: "findSymbol", description: "", jsonSchema: {}, execute: async () => "- acme/a:x.ts L1-2 foo" },
    ];
    const { provider, sendMessageWithTools } = providerScript([
      {
        content: "",
        toolCalls: [
          tc("r1", "readFile", { repo: "acme/a", path: "x.ts" }),
          tc("s1", "searchCode", { query: "foo", repo: "acme/a" }),
          tc("f1", "findSymbol", { symbol: "foo", repo: "acme/a" }),
        ],
        stopReason: "tool_use",
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        estimatedCostUsd: 0,
      },
      {
        content: "done",
        toolCalls: [],
        stopReason: "end_turn",
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        estimatedCostUsd: 0,
      },
    ]);
    await makeLoop(provider).run({
      tenant: makeTenant(),
      allowedRepos: [makeRepo()],
      history: [],
      systemPrompt: "s",
      userMessage: "u",
      tools,
    });
    const second = sendMessageWithTools.mock.calls[1]?.[0] as SendMessageWithToolsOptions;
    expect(second.toolResults).toHaveLength(3);
    for (const r of second.toolResults ?? []) {
      expect(r.isError).not.toBe(true);
      expect(r.content).toMatch(/^<untrusted_tool_output>\n[\s\S]*\n<\/untrusted_tool_output>$/);
    }
  });

  it("does NOT wrap error tool results (so the model reads the error cleanly)", async () => {
    const tool: ToolDefinition = {
      name: "readFile",
      description: "",
      jsonSchema: {},
      execute: async () => "should not run",
    };
    const { provider, sendMessageWithTools } = providerScript([
      {
        content: "",
        toolCalls: [tc("c1", "readFile", { repo: "attacker/x", path: "a.ts" })],
        stopReason: "tool_use",
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        estimatedCostUsd: 0,
      },
      {
        content: "final",
        toolCalls: [],
        stopReason: "end_turn",
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        estimatedCostUsd: 0,
      },
    ]);
    await makeLoop(provider).run({
      tenant: makeTenant(),
      allowedRepos: [makeRepo()],
      history: [],
      systemPrompt: "s",
      userMessage: "u",
      tools: [tool],
    });
    const second = sendMessageWithTools.mock.calls[1]?.[0] as SendMessageWithToolsOptions;
    expect(second.toolResults?.[0]?.isError).toBe(true);
    expect(second.toolResults?.[0]?.content).not.toContain("<untrusted_tool_output>");
  });

  it("maxToolCalls=2 allows exactly 2 invocations before forcing exit", async () => {
    const execute = vi.fn(async () => "ok");
    const tool: ToolDefinition = {
      name: "mock",
      description: "",
      jsonSchema: {},
      execute,
    };
    const { provider } = providerScript([
      {
        content: "",
        toolCalls: [
          tc("c1", "mock", { repo: "acme/a" }),
          tc("c2", "mock", { repo: "acme/a" }),
          tc("c3", "mock", { repo: "acme/a" }),
        ],
        stopReason: "tool_use",
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        estimatedCostUsd: 0,
      },
      {
        content: "",
        toolCalls: [tc("c4", "mock", { repo: "acme/a" })],
        stopReason: "tool_use",
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        estimatedCostUsd: 0,
      },
    ]);
    const result = await makeLoop(provider).run({
      tenant: makeTenant(),
      allowedRepos: [makeRepo()],
      history: [],
      systemPrompt: "s",
      userMessage: "u",
      tools: [tool],
      maxToolCalls: 2,
    });
    // Exactly 2 tool invocations executed; the 3rd (and any later) are cap-rejected.
    expect(execute).toHaveBeenCalledTimes(2);
    const okCount = result.toolCalls.filter((c) => c.ok).length;
    expect(okCount).toBe(2);
    expect(result.answer).toContain("tool-call cap reached");
  });

  it("cap + turn exhaustion returns PARTIAL_MARKER, not empty string", async () => {
    const tool: ToolDefinition = {
      name: "mock",
      description: "",
      jsonSchema: {},
      execute: async () => "ok",
    };
    // maxTurns=2, maxToolCalls=1: turn 0 pushes cap-rejected call, turn 1
    // pushes cap-rejected call too — loop exits because turn counter reaches
    // maxTurns with no end_turn, finalAnswer stayed "".
    const capTurn = {
      content: "",
      toolCalls: [tc(`c-${Math.random()}`, "mock", { repo: "acme/a" })],
      stopReason: "tool_use" as const,
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      estimatedCostUsd: 0,
    };
    const { provider } = providerScript([capTurn, { ...capTurn, toolCalls: [tc("x2", "mock", { repo: "acme/a" })] }]);
    const result = await makeLoop(provider).run({
      tenant: makeTenant(),
      allowedRepos: [makeRepo()],
      history: [],
      systemPrompt: "s",
      userMessage: "u",
      tools: [tool],
      maxTurns: 2,
      maxToolCalls: 0,
    });
    expect(result.answer).not.toBe("");
    expect(result.answer).toContain("tool-call cap reached");
  });

  it("exceeding maxToolCalls forces a final answer with partial marker", async () => {
    const tool: ToolDefinition = {
      name: "mock",
      description: "",
      jsonSchema: {},
      execute: async () => "ok",
    };
    const { provider } = providerScript([
      {
        content: "",
        toolCalls: [
          tc("c1", "mock", { repo: "acme/a" }),
          tc("c2", "mock", { repo: "acme/a" }),
        ],
        stopReason: "tool_use",
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        estimatedCostUsd: 0,
      },
      // After the cap is reached on the previous turn, the model still asks
      // for another tool. Loop forces exit.
      {
        content: "",
        toolCalls: [tc("c3", "mock", { repo: "acme/a" })],
        stopReason: "tool_use",
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        estimatedCostUsd: 0,
      },
    ]);
    const result = await makeLoop(provider).run({
      tenant: makeTenant(),
      allowedRepos: [makeRepo()],
      history: [],
      systemPrompt: "s",
      userMessage: "u",
      tools: [tool],
      maxToolCalls: 1,
    });
    expect(result.answer).toContain("tool-call cap reached");
  });
});
