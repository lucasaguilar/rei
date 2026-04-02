/**
 * ⚠️  DEPRECATED — Legacy semantic validation for the old AgentResponse contract.
 *
 * Current Architecture: REI now uses a 3-phase agent pipeline (see src/agent-mode/generator.ts):
 * - Phase 1 (context decision): Lightweight AgentDecision JSON (ready, taskType, contextRequests)
 * - Phase 2 (file resolution): Deterministic context gathering (no model)
 * - Phase 3 (final answer): Free-text markdown (no JSON contract, no semantic validation)
 *
 * This module is kept for reference only. Semantic validation is no longer performed
 * in Phase 3 — the model returns plain text that is rendered directly.
 */

import type { ChatSession } from "../chat/types.js";
import type { AgentResponse } from "../contracts/agent-response.types.js";
import {
  ANALYSIS_PATTERN,
  APPLIED_CHANGE_PATTERN,
  COMPLETED_RESPONSE_PATTERN,
  MUTATION_PATTERN,
  READ_ONLY_INSPECTION_PATTERN,
} from "./constants/semantic-validation.constants.js";

export function validateAgentResponseSemantics(
  response: AgentResponse,
  messagesForModel: ChatSession["messages"],
): string[] {
  const issues: string[] = [];
  const task = extractCurrentTask(messagesForModel);
  const analysisIntent = isAnalysisIntent(task);
  const readOnlyInspection = isReadOnlyInspectionTask(task);

  if (analysisIntent) {
    issues.push(
      ...validateResponseFieldClaims(
        "summary",
        response.summary,
        readOnlyInspection,
      ),
      ...validateResponseFieldClaims(
        "finalMessage",
        response.finalMessage,
        readOnlyInspection,
      ),
    );
  }

  return issues;
}

function validateResponseFieldClaims(
  fieldName: "summary" | "finalMessage",
  text: string,
  readOnlyInspection: boolean,
): string[] {
  const issues: string[] = [];

  if (!readOnlyInspection && containsCompletedResponseClaim(text)) {
    issues.push(
      `analysis task: ${fieldName} must not claim changes were already applied`,
    );
  }

  if (containsAppliedChangeClaim(text)) {
    issues.push(
      `analysis task: ${fieldName} must not claim repository changes were already applied`,
    );
  }

  return issues;
}

function extractCurrentTask(messagesForModel: ChatSession["messages"]): string {
  for (let i = messagesForModel.length - 1; i >= 0; i -= 1) {
    const message = messagesForModel[i];
    if (message.role !== "user") continue;

    const taskLine = message.content
      .split("\n")
      .find((line) => line.toLowerCase().startsWith("task:"));

    if (taskLine) {
      return taskLine.slice("Task:".length).trim();
    }

    return message.content.trim();
  }

  return "";
}

function isAnalysisIntent(task: string): boolean {
  const normalized = task.toLowerCase();
  if (!normalized) return false;

  if (MUTATION_PATTERN.test(normalized)) return false;
  if (ANALYSIS_PATTERN.test(normalized)) return true;
  return true;
}

function isReadOnlyInspectionTask(task: string): boolean {
  const normalized = task.toLowerCase();
  if (!normalized) return false;

  if (MUTATION_PATTERN.test(normalized)) return false;
  return READ_ONLY_INSPECTION_PATTERN.test(normalized);
}

function containsCompletedResponseClaim(text: string): boolean {
  return COMPLETED_RESPONSE_PATTERN.test(text);
}

function containsAppliedChangeClaim(text: string): boolean {
  return APPLIED_CHANGE_PATTERN.test(text);
}
