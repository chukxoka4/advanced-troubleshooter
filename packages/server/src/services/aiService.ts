import type { Tenant } from "../config/tenants.js";
import type { GithubMcpClient } from "../infrastructure/githubClient.js";
import type { IssueCreator } from "../infrastructure/issueCreator.js";
import { rootLogger } from "../infrastructure/logger.js";
import type { LlmFactory } from "../infrastructure/llm/llmFactory.js";
import type { Message } from "../infrastructure/llm/types.js";
import type { AnalyticsRepository } from "../repositories/analytics.repository.js";
import type {
  ConversationRepository,
  ConversationRow,
} from "../repositories/conversation.repository.js";
import type { RepoMapRepository } from "../repositories/repoMap.repository.js";
import type { AgentLoopToolCallRecord } from "./agentLoop.service.js";
import { createAgentLoop } from "./agentLoop.service.js";
import { buildDefaultAgentTools } from "./defaultAgentTools.js";
import type { RepoMapService } from "./repoMap.service.js";
import { validate as validateRepoScope } from "./repoScope.service.js";

/**
 * Orchestrates chat: repo scope → conversation history → scoped repo-map
 * prompt block → agent tool loop → persistence and analytics.
 */

export interface AskQuestionInput {
  tenant: Tenant;
  sessionId: string;
  question: string;
  repoScope?: string[];
}

export interface AskQuestionResult {
  answer: string;
  reposScoped: string[];
  reposTouched: string[];
  filesReferenced: string[];
  usage: { promptTokens: number; completionTokens: number; totalTokens: number };
  estimatedCostUsd: number;
  toolCalls: AgentLoopToolCallRecord[];
}

export interface AiServiceDeps {
  conversationRepo: ConversationRepository;
  analyticsRepo: AnalyticsRepository;
  githubClient: GithubMcpClient;
  llmFactory: LlmFactory;
  repoMapService: RepoMapService;
  repoMapRepository: RepoMapRepository;
  issueCreator: IssueCreator;
  now?: () => number;
  maxHistoryMessages?: number;
}

export interface AiService {
  askQuestion(input: AskQuestionInput): Promise<AskQuestionResult>;
}

const DEFAULT_HISTORY = 20;

function toLlmHistory(rows: ConversationRow[]): Message[] {
  return rows.map((row) => ({
    role: row.role === "agent" ? "user" : "assistant",
    content: row.message,
  }));
}

function reposTouchedFromLoop(
  toolCalls: AgentLoopToolCallRecord[],
  filesReferenced: string[],
): string[] {
  const seen = new Set<string>();
  for (const c of toolCalls) {
    if (!c.ok) continue;
    const repo = c.arguments.repo;
    if (typeof repo === "string" && repo.includes("/")) seen.add(repo);
  }
  for (const ref of filesReferenced) {
    const colon = ref.indexOf(":");
    if (colon > 0) seen.add(ref.slice(0, colon));
  }
  return [...seen].sort();
}

export function createAiService(deps: AiServiceDeps): AiService {
  const now = deps.now ?? (() => Date.now());
  const historyLimit = deps.maxHistoryMessages ?? DEFAULT_HISTORY;

  return {
    async askQuestion({ tenant, sessionId, question, repoScope }) {
      if (!sessionId) throw new Error("aiService.askQuestion: sessionId is required");
      if (!question || !question.trim()) {
        throw new Error("aiService.askQuestion: question is required");
      }
      const startedAt = now();
      const { allowedRepos } = validateRepoScope(
        repoScope !== undefined ? { repoScope } : {},
        tenant,
      );
      const reposScoped = allowedRepos.map((r) => `${r.owner}/${r.name}`);

      const history = await deps.conversationRepo.getHistory(tenant.tenantId, sessionId, historyLimit);
      const mapBlock = await deps.repoMapService.renderForScope(tenant, reposScoped);
      const systemPrompt = [
        tenant.systemPrompt,
        "---",
        "Repository map (in-scope; symbols may be stale until the map job runs):",
        mapBlock.length > 0
          ? mapBlock
          : "(no cached map rows for these repos — use searchCode, findSymbol, and readFile.)",
      ].join("\n\n");

      await deps.conversationRepo.saveMessage({
        tenantId: tenant.tenantId,
        sessionId,
        role: "agent",
        message: question,
        reposSearched: reposScoped,
      });

      const provider = deps.llmFactory.getProvider(tenant);
      const agentLoop = createAgentLoop({
        provider,
        githubClient: deps.githubClient,
        repoMapRepository: deps.repoMapRepository,
        logger: rootLogger,
      });

      const loopResult = await agentLoop.run({
        tenant,
        allowedRepos,
        history: toLlmHistory(history),
        systemPrompt,
        userMessage: question.trim(),
        tools: buildDefaultAgentTools(tenant, deps.issueCreator),
      });

      const reposTouched = reposTouchedFromLoop(loopResult.toolCalls, loopResult.filesReferenced);

      await deps.conversationRepo.saveMessage({
        tenantId: tenant.tenantId,
        sessionId,
        role: "assistant",
        message: loopResult.answer,
        reposSearched: reposScoped,
        filesReferenced: loopResult.filesReferenced,
      });

      const latencyMs = now() - startedAt;
      await deps.analyticsRepo.logEvent({
        tenantId: tenant.tenantId,
        sessionId,
        eventType: "query",
        latencyMs,
        reposCount: reposScoped.length,
        metadata: {
          provider: provider.name,
          model: provider.model,
          promptTokens: loopResult.usage.promptTokens,
          completionTokens: loopResult.usage.completionTokens,
          estimatedCostUsd: loopResult.cost,
          toolCallCount: loopResult.toolCalls.length,
          reposScoped,
        },
      });

      return {
        answer: loopResult.answer,
        reposScoped,
        reposTouched,
        filesReferenced: loopResult.filesReferenced,
        usage: loopResult.usage,
        estimatedCostUsd: loopResult.cost,
        toolCalls: loopResult.toolCalls,
      };
    },
  };
}
