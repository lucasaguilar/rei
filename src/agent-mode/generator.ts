import type { ChatSession } from "../chat/types.js";
import type { AgentResponse } from "../contracts/agent-response.types.js";
import type { ModelProvider } from "../providers/model-provider.js";
import { resolveContextRequests } from "./context-resolution.js";
import {
  buildAgentRepairPrompt,
  buildDegradedAgentFallback,
  normalizeAgentResponsePathsOnParsed,
  parseAgentResponseWithRecovery,
} from "./response-handler.js";
import { validateAgentResponseSemantics } from "./semantic-validation.js";

const MAX_CONTEXT_ROUNDS = 2;

export async function generateAgentModeResponse(params: {
  provider: ModelProvider;
  messagesForModel: ChatSession["messages"];
  workspacePath: string;
  repairRetries: number;
}): Promise<string> {
  const { provider, messagesForModel, workspacePath, repairRetries } = params;

  // alreadyResolved tracks absolute paths provided across all context rounds
  // to prevent re-sending the same files on subsequent rounds.
  const alreadyResolved = new Set<string>();

  let currentMessages: ChatSession["messages"] = messagesForModel;

  for (let round = 0; round <= MAX_CONTEXT_ROUNDS; round += 1) {
    const result = await runAgentPipeline({
      provider,
      messagesForModel: currentMessages,
      workspacePath,
      repairRetries,
    });

    if (result.kind === "fallback") {
      return result.json;
    }

    const response = result.response;

    // If the model is satisfied, return immediately.
    if (!response.needsMoreContext) {
      return JSON.stringify(response, null, 2);
    }

    // If the model claims it needs more context but provides no requests,
    // treat this as a semantic contract violation and fall back.
    if (response.needsMoreContext && response.contextRequests.length === 0) {
      console.warn(
        `[REI debug] Agent context loop: needsMoreContext=true but no contextRequests provided, engaging fallback`
      );
      return JSON.stringify(
        buildDegradedAgentFallback(
          result.rawResponse,
          new Error("needsMoreContext is true but contextRequests is empty"),
          "semantic"
        ),
        null,
        2
      );
    }
    // If we've exhausted context rounds, fall back gracefully.
    if (round === MAX_CONTEXT_ROUNDS) {
      console.warn(
        `[REI debug] Agent context loop exhausted after ${MAX_CONTEXT_ROUNDS} round(s), engaging fallback`
      );
      return JSON.stringify(
        buildDegradedAgentFallback(
          result.rawResponse,
          new Error(`needsMoreContext still true after ${MAX_CONTEXT_ROUNDS} context round(s)`),
          "semantic"
        ),
        null,
        2
      );
    }

    const requestedPaths = response.contextRequests.map((r) => r.path);
    console.warn(
      `[REI debug] Agent context round ${round + 1}/${MAX_CONTEXT_ROUNDS} — resolving ${response.contextRequests.length} request(s): [${requestedPaths.join(", ")}]`
    );

    const { contextMessage, resolved } = await resolveContextRequests(
      response.contextRequests,
      workspacePath,
      alreadyResolved
    );

    if (resolved.length === 0) {
      console.warn(`[REI debug] Agent context loop: no new paths resolved, stopping`);
      return JSON.stringify(response, null, 2);
    }

    currentMessages = [
      ...currentMessages,
      { role: "assistant", content: JSON.stringify(response, null, 2) },
      { role: "user", content: contextMessage },
    ];
  }

  // Unreachable — loop always returns above.
  /* istanbul ignore next */
  throw new Error("Unexpected exit from context resolution loop");
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

type PipelineSuccess = { kind: "success"; response: AgentResponse; rawResponse: string };
type PipelineFallback = { kind: "fallback"; json: string };
type PipelineResult = PipelineSuccess | PipelineFallback;

async function runAgentPipeline(params: {
  provider: ModelProvider;
  messagesForModel: ChatSession["messages"];
  workspacePath: string;
  repairRetries: number;
}): Promise<PipelineResult> {
  const { provider, messagesForModel, workspacePath, repairRetries } = params;

  let rawResponse = await provider.completeChat(messagesForModel);
  let lastError: Error | undefined;
  let lastFailureKind: "structural" | "semantic" = "structural";

  for (let attempt = 0; attempt <= repairRetries; attempt += 1) {
    try {
      const recovered = parseAgentResponseWithRecovery(rawResponse);
      const response = normalizeAgentResponsePathsOnParsed(recovered.response, workspacePath);
      const semanticIssues = validateAgentResponseSemantics(response, messagesForModel);
      if (semanticIssues.length > 0) {
        lastFailureKind = "semantic";
        throw new Error(`Invalid AGENT mode semantic response: ${semanticIssues.join("; ")}`);
      }
      if (recovered.stage !== "direct") {
        console.warn(`[REI debug] Agent JSON recovered via: ${recovered.stage}`);
      }
      return { kind: "success", response, rawResponse };
    } catch (error: unknown) {
      if (!(error instanceof Error)) {
        throw error;
      }
      lastError = error;
      if (!error.message.includes("semantic")) {
        lastFailureKind = "structural";
      }

      console.warn(
        `[REI debug] Agent ${lastFailureKind} retry ${attempt + 1}/${repairRetries + 1} failed: ${error.message}`
      );

      if (attempt === repairRetries) {
        break;
      }

      const repairMessages: ChatSession["messages"] = [
        ...messagesForModel,
        {
          role: "user",
          content: buildAgentRepairPrompt(error.message),
        },
      ];

      rawResponse = await provider.completeChat(repairMessages);
    }
  }

  console.warn(
    `[REI debug] Agent mode fallback engaged after ${repairRetries + 1} attempt(s) [${lastFailureKind}]: ${lastError?.message ?? "unknown validation error"}`
  );

  return {
    kind: "fallback",
    json: JSON.stringify(buildDegradedAgentFallback(rawResponse, lastError, lastFailureKind), null, 2),
  };
}