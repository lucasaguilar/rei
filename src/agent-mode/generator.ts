import type { ChatSession } from "../chat/types.js";
import type { ModelProvider } from "../providers/model-provider.js";
import {
  buildAgentRepairPrompt,
  buildDegradedAgentFallback,
  normalizeAgentResponsePaths,
  parseAgentResponseWithRecovery,
} from "./response-handler.js";
import { validateAgentResponseSemantics } from "./semantic-validation.js";

export async function generateAgentModeResponse(params: {
  provider: ModelProvider;
  messagesForModel: ChatSession["messages"];
  workspacePath: string;
  repairRetries: number;
}): Promise<string> {
  const { provider, messagesForModel, workspacePath, repairRetries } = params;

  let rawResponse = await provider.completeChat(messagesForModel);
  let lastError: Error | undefined;
  let lastFailureKind: "structural" | "semantic" = "structural";

  for (let attempt = 0; attempt <= repairRetries; attempt += 1) {
    try {
      const normalized = normalizeAgentResponsePaths(rawResponse, workspacePath);
      const recovered = parseAgentResponseWithRecovery(normalized);
      const semanticIssues = validateAgentResponseSemantics(recovered.response, messagesForModel);
      if (semanticIssues.length > 0) {
        lastFailureKind = "semantic";
        throw new Error(`Invalid AGENT mode semantic response: ${semanticIssues.join("; ")}`);
      }
      if (recovered.stage !== "direct") {
        console.warn(`[REI debug] Agent JSON recovered via: ${recovered.stage}`);
      }
      return JSON.stringify(recovered.response, null, 2);
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

  return JSON.stringify(buildDegradedAgentFallback(rawResponse, lastError, lastFailureKind), null, 2);
}