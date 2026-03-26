import type { ChatSession } from "../chat/types.js";
import type { ModelProvider } from "../providers/model-provider.js";
import type { FileMeta } from "../workspace/workspace-scanner.js";
import { parseAgentDecision, type AgentDecision } from "../contracts/agent-decision.types.js";
import { resolveContextRequests } from "./context-resolution.js";
import { sanitizeAgentJsonText } from "./response-handler.js";
import { buildAgentDecisionSystemMessage } from "../prompts/prompt-builder.js";

const DECISION_RETRIES = 2;

export async function generateAgentModeResponse(params: {
  provider: ModelProvider;
  messagesForModel: ChatSession["messages"];
  workspacePath: string;
  scannedFiles: FileMeta[];
}): Promise<string> {
  const { provider, messagesForModel, workspacePath, scannedFiles } = params;

  // --- Phase 1: Context Decision ---
  const decision = await runDecisionPhase(provider, messagesForModel);
  console.warn(
    `[REI debug] Agent decision: taskType=${decision.taskType}, ready=${decision.ready}, contextRequests=[${decision.contextRequests.map((r) => r.path).join(", ")}]`
  );

  // --- Phase 2: Context Resolution ---
  let answerMessages = messagesForModel;
  if (decision.contextRequests.length > 0) {
    const alreadyResolved = new Set<string>();
    const { contextMessage, resolved } = await resolveContextRequests(
      decision.contextRequests,
      workspacePath,
      alreadyResolved,
      scannedFiles
    );
    if (resolved.length > 0 && contextMessage) {
      console.warn(
        `[REI debug] Agent context resolved ${resolved.length} file(s), injecting into answer phase`
      );
      answerMessages = appendContextToLastUserMessage(messagesForModel, contextMessage);
    }
  }

  // --- Phase 3: Answer ---
  // Free-text response. No JSON contract, no semantic validation.
  return provider.completeChat(answerMessages);
}

// ---------------------------------------------------------------------------

async function runDecisionPhase(
  provider: ModelProvider,
  messagesForModel: ChatSession["messages"]
): Promise<AgentDecision> {
  const lastUserMessage = [...messagesForModel].reverse().find((m) => m.role === "user");
  const decisionMessages: ChatSession["messages"] = [
    { role: "system", content: buildAgentDecisionSystemMessage() },
    ...(lastUserMessage ? [lastUserMessage] : []),
  ];

  let raw = await provider.completeChat(decisionMessages);

  for (let attempt = 0; attempt <= DECISION_RETRIES; attempt += 1) {
    try {
      const sanitized = sanitizeAgentJsonText(raw) || raw;
      const decision = parseAgentDecision(sanitized);
      if (attempt > 0) {
        console.warn(`[REI debug] Agent decision parsed after ${attempt + 1} attempt(s)`);
      }
      return decision;
    } catch (err) {
      if (attempt === DECISION_RETRIES) {
        console.warn(
          `[REI debug] Agent decision parsing failed after ${DECISION_RETRIES + 1} attempt(s), proceeding without context resolution`
        );
        return { ready: true, taskType: "inspection", contextRequests: [] };
      }

      const repairMessages: ChatSession["messages"] = [
        ...decisionMessages,
        { role: "assistant", content: raw },
        {
          role: "user",
          content: [
            "Your response was not valid JSON for the context evaluation step.",
            `Error: ${err instanceof Error ? err.message : String(err)}`,
            'Return only a JSON object with exactly these fields: ready (boolean), taskType ("inspection" or "change-planning"), contextRequests (array of {path, reason} objects).',
            "No markdown fences, no prose. First character must be { and last must be }.",
          ].join("\n"),
        },
      ];
      raw = await provider.completeChat(repairMessages);
    }
  }

  /* istanbul ignore next */
  return { ready: true, taskType: "inspection", contextRequests: [] };
}

function appendContextToLastUserMessage(
  messages: ChatSession["messages"],
  contextAddendum: string
): ChatSession["messages"] {
  const result = [...messages];
  for (let i = result.length - 1; i >= 0; i -= 1) {
    if (result[i].role === "user") {
      result[i] = { ...result[i], content: result[i].content + "\n\n" + contextAddendum };
      return result;
    }
  }
  return result;
}
