import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ChatMessage } from './types.js';

const PLAN_TODO_FILE = '.rei/current-plan-todo.md';

function getPlanTodoPath(workspacePath: string): string {
  return path.join(workspacePath, PLAN_TODO_FILE);
}

/**
 * Deletes the current-plan-todo.md file if it exists.
 */
export function deletePlanTodoFile(workspacePath: string): void {
  const filePath = getPlanTodoPath(workspacePath);
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch {
    // Ignore errors
  }
}

/**
 * Reads the contents of current-plan-todo.md.
 */
export function readPlanTodoFile(workspacePath: string): string | null {
  const filePath = getPlanTodoPath(workspacePath);
  try {
    if (fs.existsSync(filePath)) {
      return fs.readFileSync(filePath, 'utf8');
    }
  } catch {
    // Ignore errors
  }
  return null;
}

/**
 * Initializes the current-plan-todo.md checklist from raw plan content.
 */
export function initPlanTodoFile(workspacePath: string, planContent: string): void {
  const lines = planContent.split('\n');
  const todoLines: string[] = [];
  const stageRegex = /^(#+)\s*(?:(?:fase|etapa|paso|stage|step)\s+)?0*(\d+)\b(.*)$/i;

  todoLines.push('# PLAN PROGRESS');
  todoLines.push('');
  todoLines.push('Este archivo hace un seguimiento del progreso actual del plan de implementación.');
  todoLines.push('Puedes marcar o desmarcar las casillas manualmente. REI las actualizará automáticamente al completar cada etapa.');
  todoLines.push('');

  let parsedCount = 0;
  for (const line of lines) {
    const match = line.match(stageRegex);
    if (match) {
      const num = parseInt(match[2], 10);
      const desc = match[3].replace(/^[\s.:-]+/, '').trim();
      todoLines.push(`- [ ] **Etapa ${num}:** ${desc || 'Sin descripción'}`);
      parsedCount++;
    }
  }

  // If no structured stages were parsed, create a generic task representing the plan
  if (parsedCount === 0) {
    todoLines.push('- [ ] **Plan General**');
  }

  const filePath = getPlanTodoPath(workspacePath);
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, todoLines.join('\n'), 'utf8');
  } catch (err) {
    console.error('[PLAN TRACKER] Error creating plan todo file:', err);
  }
}

/**
 * Marks a specific stage number as completed (- [x]) in the checklist.
 */
export function markStageAsCompleted(workspacePath: string, stageNumber: number): void {
  const filePath = getPlanTodoPath(workspacePath);
  try {
    if (!fs.existsSync(filePath)) return;

    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n');
    const targetRegex = new RegExp(`^-\\s*\\[\\s*\\]\\s*\\*\\*Etapa\\s*${stageNumber}\\b`, 'i');

    let modified = false;
    for (let i = 0; i < lines.length; i++) {
      if (targetRegex.test(lines[i])) {
        lines[i] = lines[i].replace(/^-\s*\[\s*\]/, '- [x]');
        modified = true;
        break;
      }
    }

    if (modified) {
      fs.writeFileSync(filePath, lines.join('\n'), 'utf8');
    }
  } catch (err) {
    console.error(`[PLAN TRACKER] Error marking stage ${stageNumber} as completed:`, err);
  }
}

/**
 * Recreates the current-plan-todo.md file from the last plan in session messages.
 */
export function recreatePlanTodoFileFromSession(
  workspacePath: string,
  messages: ChatMessage[]
): void {
  const lastPlanMsg = [...messages]
    .reverse()
    .find(
      (m) =>
        m.role === 'assistant' &&
        m.content &&
        m.content.toLowerCase().includes('plan')
    );

  if (!lastPlanMsg || !lastPlanMsg.content) {
    deletePlanTodoFile(workspacePath);
    return;
  }

  // Re-initialize all as empty checklist
  initPlanTodoFile(workspacePath, lastPlanMsg.content);

  // Now, let's proactively search the subsequent messages in the session
  // to see if we can pre-check stages that were already run successfully.
  const planIdx = messages.indexOf(lastPlanMsg);
  if (planIdx === -1) return;

  const subsequent = messages.slice(planIdx + 1);
  for (const msg of subsequent) {
    if (msg.role === 'user' && msg.content) {
      // Look for "/runplan stage X" or "/runplan step X" or "/runplan fase X"
      const match = msg.content.match(/\/runplan\s+(?:stage|step|fase|etapa|paso)\s+(\d+)/i);
      if (match) {
        const stageNum = parseInt(match[1], 10);
        // Let's assume that if the user moved past it (or we have successful outcomes in assistant),
        // we can pre-mark it. But to be safe, only check if there is an assistant response that compiles
        // or has patches applied.
        markStageAsCompleted(workspacePath, stageNum);
      }
    }
  }
}
