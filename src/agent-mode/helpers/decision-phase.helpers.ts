import { jsonrepair } from "jsonrepair";
import type { ChatSession } from "../../chat/types.js";
import type { AgentDecision } from "../../contracts/agent-decision.types.js";
import type { AgentLogger } from "../../core/logger.js";
import type { ModelProvider } from "../../providers/model-provider.js";
import { buildAgentDecisionSystemMessage } from "../../prompts/prompt-builder.js";
import {
  buildFallbackDecisionFromTask,
  extractCurrentTask,
  extractPathLikeTokens,
  extractProvidedContextPaths,
  normalizeDecision,
  shouldRetryForMissingChangePatch,
} from "./decision-path.helpers.js";
import { sanitizeAgentJsonText } from "./response-json.helpers.js";

export async function runDecisionPhase(params: {
  provider: ModelProvider;
  messagesForModel: ChatSession["messages"];
  logger: AgentLogger;
  retryLimit: number;
  parseAgentDecision: (raw: string) => AgentDecision;
}): Promise<AgentDecision> {
  const { provider, messagesForModel, logger, retryLimit, parseAgentDecision } =
    params;
  const lastUserMessage = [...messagesForModel]
    .reverse()
    .find((message) => message.role === "user");
  const lastUserContent = lastUserMessage?.content ?? "";
  const currentTask = extractCurrentTask(lastUserContent);
  const decisionMessages: ChatSession["messages"] = [
    { role: "system", content: buildAgentDecisionSystemMessage() },
    ...(lastUserMessage ? [lastUserMessage] : []),
  ];
  const explicitTaskPaths = extractPathLikeTokens(currentTask);
  const providedContextPaths = extractProvidedContextPaths(lastUserContent);

  let raw = await provider.completeChat(decisionMessages);
  let attemptedChangePlanningRecovery = false;

  for (let attempt = 0; attempt <= retryLimit; attempt += 1) {
    try {
      const parsed = parseDecisionWithRecovery(raw, parseAgentDecision);
      logger.logDecision(raw, parsed);
      const decision = normalizeDecision(
        parsed,
        currentTask,
        explicitTaskPaths,
        providedContextPaths,
      );

      if (
        shouldRetryForMissingChangePatch(
          decision,
          currentTask,
          explicitTaskPaths,
          providedContextPaths,
          attemptedChangePlanningRecovery,
        )
      ) {
        attemptedChangePlanningRecovery = true;
        raw = await provider.completeChat([
          ...decisionMessages,
          { role: "assistant", content: raw },
          {
            role: "user",
            content: [
              "The task is clearly a change request and target file(s) are already visible in context.",
              'Return a corrected decision JSON with taskType="change-planning" and include at least one proposedPatch.',
              "Do not request placeholder files like src/foo.ts.",
              "Return only JSON. No prose.",
            ].join("\n"),
          },
        ]);
        continue;
      }

      return decision;
    } catch (error) {
      if (attempt === retryLimit) {
        return buildFallbackDecisionFromTask(currentTask);
      }

      const repairMessages: ChatSession["messages"] = [
        ...decisionMessages,
        { role: "assistant", content: raw },
        {
          role: "user",
          content: [
            "Your response was not valid JSON for the context evaluation step.",
            `Error: ${error instanceof Error ? error.message : String(error)}`,
            'Return only a JSON object with these fields: ready (boolean), taskType ("inspection" or "change-planning"), contextRequests (array of {path, reason} objects), proposedPatches (optional array of {file, description, patch}).',
            "No markdown fences, no prose. First character must be { and last must be }.",
            "Use strict booleans (true/false), double quotes, and valid escaped newlines in patch strings.",
            'Example: {"ready":true,"taskType":"change-planning","contextRequests":[],"proposedPatches":[]}',
          ].join("\n"),
        },
      ];
      raw = await provider.completeChat(repairMessages);
    }
  }

  return buildFallbackDecisionFromTask(currentTask);
}

function parseDecisionWithRecovery(
  raw: string,
  parseAgentDecision: (raw: string) => AgentDecision,
): AgentDecision {
  const sanitized = sanitizeAgentJsonText(raw) || raw;

  try {
    return parseAgentDecision(sanitized);
  } catch {
    // Continue with jsonrepair-based recovery.
  }

  const repaired = jsonrepair(sanitized);
  return parseAgentDecision(repaired);
}
