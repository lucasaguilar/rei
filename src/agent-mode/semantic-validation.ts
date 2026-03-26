import type { ChatSession } from "../chat/types.js";
import type { AgentResponse } from "../contracts/agent-response.types.js";

export function validateAgentResponseSemantics(
  response: AgentResponse,
  messagesForModel: ChatSession["messages"]
): string[] {
  const issues: string[] = [];
  const task = extractCurrentTask(messagesForModel);
  const analysisIntent = isAnalysisIntent(task);
  const readOnlyInspectionTask = isReadOnlyInspectionTask(task);

  if (analysisIntent) {
    if (!readOnlyInspectionTask && containsCompletedResponseClaim(response.summary)) {
      issues.push("analysis task: summary must not claim changes were already applied");
    }
    if (!readOnlyInspectionTask && containsCompletedResponseClaim(response.finalMessage)) {
      issues.push("analysis task: finalMessage must not claim changes were already applied");
    }

    if (containsAppliedChangeClaim(response.summary)) {
      issues.push("analysis task: summary must not claim repository changes were already applied");
    }
    if (containsAppliedChangeClaim(response.finalMessage)) {
      issues.push("analysis task: finalMessage must not claim repository changes were already applied");
    }
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

const ANALYSIS_PATTERN =
  /\b(analy[sz]e|analysis|review|inspect|explain|understand|diagnos(?:e|is)|analizy|revis[ae]|revisar|verific[ae]|verificar|mostr[ae]|mostrar|pass?arme|dame|dime|decime|tell me|show me|find|busca[r]?|encontr[ae]|listar?|explicame|expl[ií]came|mostrarme|pasame|ver)\b/;

const MUTATION_PATTERN =
  /\b(add|change|modify|update|fix|implement|create|remove|delete|refactor|write|insert|patch|agrega[r]?|cambia[r]?|modifica[r]?|actualiza[r]?|arregla[r]?|implementa[r]?|crea[r]?|elimina[r]?|borra[r]?|reescrib[ei]r?)\b/;

const READ_ONLY_INSPECTION_PATTERN =
  /\b(show me|tell me|inspect|review|explain|understand|mostr[ae]|mostrar|mostrarme|pasame|dame|dime|decime|c[oó]digo exacto|exact code|full code|contenido completo|completo|expl[ií]came|ver|see|list|listar)\b/;

const COMPLETED_RESPONSE_PATTERN =
  /\b(provided|showed|shown|reviewed|inspected|explained|listed|shared|displayed|returned|delivered)\b/i;

const APPLIED_CHANGE_PATTERN =
  /\b(added|updated|modified|changed|implemented|fixed|removed|created|wrote|inserted|applied|patched|refactored)\b/i;