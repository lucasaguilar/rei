import type { ChatSession } from "../chat/types.js";
import type { AgentResponse } from "../contracts/agent-response.types.js";

export function validateAgentResponseSemantics(
  response: AgentResponse,
  messagesForModel: ChatSession["messages"]
): string[] {
  const issues: string[] = [];
  const task = extractCurrentTask(messagesForModel);
  const analysisIntent = isAnalysisIntent(task);

  if (analysisIntent) {
    if (containsExecutionClaim(response.summary)) {
      issues.push("analysis task: summary must not claim changes were already applied");
    }
    if (containsExecutionClaim(response.finalMessage)) {
      issues.push("analysis task: finalMessage must not claim changes were already applied");
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

  const analysisPattern =
    /\b(analy[sz]e|analysis|review|inspect|explain|understand|diagnos(?:e|is)|analizy|revis[ae]|revisar|verific[ae]|verificar|mostr[ae]|mostrar|pass?arme|dame|dime|decime|tell me|show me|find|busca[r]?|encontr[ae]|listar?)\b/;
  const mutationPattern =
    /\b(add|change|modify|update|fix|implement|create|remove|delete|refactor|write|insert|patch|agrega[r]?|cambia[r]?|modifica[r]?|actualiza[r]?|arregla[r]?|implementa[r]?|crea[r]?|elimina[r]?|borra[r]?|reescrib[ei]r?)\b/;

  if (mutationPattern.test(normalized)) return false;
  if (analysisPattern.test(normalized)) return true;
  return true;
}

function containsExecutionClaim(text: string): boolean {
  const executionPattern =
    /\b(added|updated|modified|changed|implemented|fixed|removed|created|wrote|inserted|applied|done)\b/i;
  return executionPattern.test(text);
}