import type { Logger } from "pino";
import type { Tenant } from "../config/tenants.js";
import type { GithubMcpClient } from "../infrastructure/githubClient.js";
import type {
  LlmProvider,
  Message,
  ToolResult,
  ToolTurn,
  TokenUsage,
} from "../infrastructure/llm/types.js";
import type { RepoMapRepository } from "../repositories/repoMap.repository.js";
import { ValidationError } from "../shared/errors/index.js";
import type { TenantRepo } from "./repoScope.service.js";
import type { ToolContext, ToolDefinition } from "./tools/types.js";

/**
 * Agent loop. Orchestrates the tool-calling conversation with the LLM:
 *
 *   user turn → provider.sendMessageWithTools
 *     ↳ if final answer → return it
 *     ↳ if tool_use     → dispatcher executes each tool, re-validates
 *                         args.repo ∈ allowedRepos (defence in depth),
 *                         feeds ToolResults back on the next turn
 *
 * Caps:
 *   maxTurns      — hard stop on the outer loop; prevents runaway latency.
 *   maxToolCalls  — hard stop on total tool invocations across all turns;
 *                   when exceeded we force a final answer with a
 *                   partial-result marker in the tool-result stream so the
 *                   model stops asking and summarises what it has.
 *
 * Provider errors propagate; they are never swallowed here.
 *
 * Retrieved file content from tools is passed through untouched —
 * wrapping / sanitisation is the caller's job at the prompt boundary.
 */

export interface AgentLoopRunInput {
  tenant: Tenant;
  allowedRepos: ReadonlyArray<TenantRepo>;
  history: Message[];
  systemPrompt: string;
  userMessage: string;
  tools: ToolDefinition[];
  maxTurns?: number;
  maxToolCalls?: number;
}

export interface AgentLoopToolCallRecord {
  name: string;
  arguments: Record<string, unknown>;
  ok: boolean;
  errorMessage?: string;
}

export interface AgentLoopRunResult {
  answer: string;
  filesReferenced: string[];
  toolCalls: AgentLoopToolCallRecord[];
  usage: TokenUsage;
  cost: number;
}

export interface AgentLoopDeps {
  provider: LlmProvider;
  githubClient: GithubMcpClient;
  repoMapRepository: RepoMapRepository;
  logger: Pick<Logger, "info" | "warn" | "error" | "debug">;
}

const DEFAULT_MAX_TURNS = 8;
const DEFAULT_MAX_TOOL_CALLS = 16;
const PARTIAL_MARKER =
  "[agent-loop: tool-call cap reached — respond with the best answer from the results so far]";

/**
 * Wrap a successful tool result in an untrusted-data envelope so the model
 * treats everything between the tags as DATA, not INSTRUCTIONS. Tool outputs
 * may contain source-code text or user-controlled content with
 * prompt-injection payloads ("ignore previous instructions…"); the envelope
 * is the structural guard.
 *
 * Applied uniformly to every successful tool output; error results are left
 * unwrapped so the model can read the error cleanly.
 */
function wrapUntrusted(content: string): string {
  return `<untrusted_tool_output>\n${content}\n</untrusted_tool_output>`;
}

function isAllowedRepoArg(
  args: Record<string, unknown>,
  allowedRepos: ReadonlyArray<TenantRepo>,
): boolean {
  const repo = args.repo;
  if (repo === undefined) return true; // tool does not use a repo arg
  if (typeof repo !== "string") return false;
  return allowedRepos.some((r) => `${r.owner}/${r.name}` === repo);
}

export function createAgentLoop(deps: AgentLoopDeps): {
  run(input: AgentLoopRunInput): Promise<AgentLoopRunResult>;
} {
  return {
    async run(input: AgentLoopRunInput): Promise<AgentLoopRunResult> {
      const maxTurns = input.maxTurns ?? DEFAULT_MAX_TURNS;
      const maxToolCalls = input.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS;
      const toolsByName = new Map<string, ToolDefinition>();
      for (const t of input.tools) toolsByName.set(t.name, t);

      const ctx: ToolContext = {
        tenant: input.tenant,
        allowedRepos: input.allowedRepos,
        githubClient: deps.githubClient,
        repoMapRepository: deps.repoMapRepository,
        logger: deps.logger,
      };

      const toolSpecs = input.tools.map((t) => ({
        name: t.name,
        description: t.description,
        jsonSchema: t.jsonSchema,
      }));

      const calls: AgentLoopToolCallRecord[] = [];
      const filesReferenced: string[] = [];
      const filesSeen = new Set<string>();
      let totalUsage: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
      let totalCost = 0;

      // Accumulated (assistant tool_calls → caller-supplied tool_results)
      // pairs. Sent in full on every subsequent turn so OpenAI's strict
      // "tool message must follow its assistant.tool_calls" contract is
      // preserved; Claude/Gemini replay these too so the transcript matches
      // reality.
      const priorToolTurns: ToolTurn[] = [];
      let finalAnswer = "";
      let capReached = false;

      for (let turn = 0; turn < maxTurns; turn += 1) {
        const response = await deps.provider.sendMessageWithTools({
          systemPrompt: input.systemPrompt,
          history: input.history,
          userMessage: input.userMessage,
          tools: toolSpecs,
          ...(priorToolTurns.length > 0 ? { priorToolTurns } : {}),
        });

        totalUsage = {
          promptTokens: totalUsage.promptTokens + response.usage.promptTokens,
          completionTokens: totalUsage.completionTokens + response.usage.completionTokens,
          totalTokens: totalUsage.totalTokens + response.usage.totalTokens,
        };
        totalCost += response.estimatedCostUsd;

        if (response.toolCalls.length === 0 || response.stopReason !== "tool_use") {
          finalAnswer = response.content;
          break;
        }

        if (capReached) {
          // The previous turn already signalled the cap via PARTIAL_MARKER
          // but the model still asked for more tools. Force an exit.
          finalAnswer = response.content || PARTIAL_MARKER;
          break;
        }

        const nextResults: ToolResult[] = [];
        for (const call of response.toolCalls) {
          // Fencepost: check the cap BEFORE recording the call, so
          // maxToolCalls is a true upper bound on accepted invocations.
          if (calls.length >= maxToolCalls) {
            capReached = true;
            calls.push({
              name: call.name,
              arguments: call.arguments,
              ok: false,
              errorMessage: "tool-call cap exceeded",
            });
            nextResults.push({
              toolCallId: call.id,
              name: call.name,
              content: PARTIAL_MARKER,
              isError: true,
            });
            continue;
          }

          calls.push({ name: call.name, arguments: call.arguments, ok: false });
          const record = calls[calls.length - 1] as AgentLoopToolCallRecord;

          const tool = toolsByName.get(call.name);
          if (!tool) {
            record.errorMessage = `unknown tool: ${call.name}`;
            nextResults.push({
              toolCallId: call.id,
              name: call.name,
              content: `error: unknown tool "${call.name}"`,
              isError: true,
            });
            continue;
          }

          // Dispatcher-level scope re-validation (belt + braces; every tool
          // also validates internally).
          if (!isAllowedRepoArg(call.arguments, input.allowedRepos)) {
            record.errorMessage = "repo not in tenant scope";
            nextResults.push({
              toolCallId: call.id,
              name: call.name,
              content: "error: repo not in tenant scope",
              isError: true,
            });
            continue;
          }

          try {
            const result = await tool.execute(call.arguments, ctx);
            record.ok = true;
            if (call.name === "readFile" && typeof call.arguments.repo === "string" && typeof call.arguments.path === "string") {
              const key = `${call.arguments.repo}:${call.arguments.path}`;
              if (!filesSeen.has(key)) {
                filesSeen.add(key);
                filesReferenced.push(key);
              }
            }
            nextResults.push({
              toolCallId: call.id,
              name: call.name,
              content: wrapUntrusted(result),
            });
          } catch (err) {
            if (err instanceof ValidationError) {
              record.errorMessage = err.message;
              nextResults.push({
                toolCallId: call.id,
                name: call.name,
                content: `error: ${err.message}`,
                isError: true,
              });
              continue;
            }
            // Non-domain errors propagate — do not swallow provider/network bugs.
            throw err;
          }
        }

        priorToolTurns.push({
          toolCalls: response.toolCalls,
          toolResults: nextResults,
        });

        if (capReached) {
          // loop once more so the model can close out with the partial marker
          continue;
        }
      }

      // If the loop exhausted its turns after hitting the tool-call cap but
      // never got a clean end_turn, surface the partial marker rather than
      // returning an empty string — callers need to know the answer is
      // incomplete.
      if (finalAnswer === "" && capReached) {
        finalAnswer = PARTIAL_MARKER;
      }

      return {
        answer: finalAnswer,
        filesReferenced,
        toolCalls: calls,
        usage: totalUsage,
        cost: totalCost,
      };
    },
  };
}
