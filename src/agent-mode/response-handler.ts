/**
 * ⚠️  DEPRECATED — Legacy agent response parsing for the old AgentResponse contract.
 *
 * Current Architecture: REI now uses a 3-phase agent pipeline (see src/agent-mode/generator.ts):
 * - Phase 1 (context decision): Lightweight AgentDecision JSON (ready, taskType, contextRequests)
 * - Phase 2 (file resolution): Deterministic context gathering (no model)
 * - Phase 3 (final answer): Free-text markdown (no JSON contract, no semantic validation)
 *
 * This module is kept for reference only.
 * New agent workflows should use src/contracts/agent-decision.types.ts instead.
 */

import { jsonrepair } from "jsonrepair";
import {
  parseAgentResponse,
  validateAgentResponse,
  type AgentResponse,
} from "../contracts/agent-response.types.js";
import type {
  ParseRecoveryResult,
  ParseRecoveryStage,
} from "./models/response-handler.types.js";
import { sanitizeAgentJsonText } from "./helpers/response-json.helpers.js";
import {
  normalizeAgentResponsePaths,
  normalizeAgentResponsePathsOnParsed,
} from "./helpers/response-path-normalization.helpers.js";

export { sanitizeAgentJsonText };
export { normalizeAgentResponsePathsOnParsed, normalizeAgentResponsePaths };

export function parseAgentResponseWithRecovery(
  rawResponse: string,
): ParseRecoveryResult {
  try {
    return { response: parseAgentResponse(rawResponse), stage: "direct" };
  } catch {
    // continue with conservative recovery steps
  }

  const sanitized = sanitizeAgentJsonText(rawResponse);
  if (sanitized) {
    try {
      return { response: parseAgentResponse(sanitized), stage: "sanitized" };
    } catch {
      // continue with syntactic repair
    }

    try {
      const repaired = jsonrepair(sanitized);
      return { response: parseAgentResponse(repaired), stage: "repaired" };
    } catch {
      // fall through to throw original parse error below
    }
  }

  return { response: parseAgentResponse(rawResponse), stage: "direct" };
}

export function buildAgentRepairPrompt(validationError: string): string {
  const isSemantic = validationError.includes("semantic");
  const isPathError = validationError.includes("workspace-relative path");

  const extra: string[] = [];

  if (isSemantic) {
    extra.push(
      'IMPORTANT: Write summary and finalMessage in proposal tense (e.g. "Propose to add…", "Would add…") for change-oriented analysis tasks.',
      "Exception: for read-only inspection tasks that ask to show or explain existing code/content, summary and finalMessage may describe the inspection as completed, but must not claim repository modifications were applied.",
      "If the task requests a repository change, include at least one modify action or one proposedChange.",
    );
  }

  if (isPathError) {
    extra.push(
      'IMPORTANT: All file paths (in actions[].target, proposedChanges[].file, contextRequests[].path) must be workspace-relative (e.g. "src/main.ts", NOT "/workspaces/rei/src/main.ts").',
    );
  }

  return [
    "Your previous AGENT mode response failed validation.",
    `Validation error: ${validationError}`,
    "Return a corrected response as raw JSON only.",
    "Do not include markdown fences or extra prose.",
    "The first character of your response must be { and the last character must be }.",
    "Your response must not contain triple backticks anywhere.",
    "Keep the same intent and include every required field from the AGENT contract.",
    ...extra,
  ].join("\n");
}

export function buildDegradedAgentFallback(
  rawResponse: string,
  error?: Error,
  cause: "structural" | "semantic" = "structural",
): AgentResponse {
  const excerpt = sanitizeAgentJsonText(rawResponse).slice(0, 240);
  const detail = error?.message ?? "unknown parsing/validation error";
  const causeLabel =
    cause === "semantic"
      ? "non-conforming-agent-semantics"
      : "non-conforming-agent-output";
  const causeText =
    cause === "semantic" ? "semantically aligned" : "parsed/validated";

  return validateAgentResponse({
    version: "1.0",
    mode: "agent",
    summary:
      "The model returned a non-conforming AGENT response; REI produced a degraded fallback.",
    confidence: 0,
    needsMoreContext: false,
    contextRequests: [],
    actions: [],
    proposedChanges: [],
    risks: [
      {
        label: causeLabel,
        detail: `Model output could not be ${causeText} (${detail}).`,
      },
    ],
    finalMessage: excerpt
      ? `The model response was not valid for the AGENT contract (${cause}). Sanitized excerpt: ${excerpt}`
      : `The model response was not valid for the AGENT contract (${cause}) and could not be recovered.`,
  });
}
