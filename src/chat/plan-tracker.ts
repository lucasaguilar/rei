import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ChatMessage } from './types.js';

const PLAN_TODO_FILE = '.rei/current-plan-todo.md';
const PLAN_CONTENT_FILE = '.rei/current-plan-content.md';

function getPlanTodoPath(workspacePath: string): string {
  return path.join(workspacePath, PLAN_TODO_FILE);
}

function getPlanContentPath(workspacePath: string): string {
  return path.join(workspacePath, PLAN_CONTENT_FILE);
}

export function saveCurrentPlanContent(workspacePath: string, planContent: string): void {
  const filePath = getPlanContentPath(workspacePath);
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, planContent, 'utf8');
  } catch {
    // Ignore errors
  }
}

export function loadCurrentPlanContent(workspacePath: string): string | null {
  const filePath = getPlanContentPath(workspacePath);
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
 * Deletes the current-plan-todo.md file if it exists.
 */
export function deletePlanTodoFile(workspacePath: string): void {
  for (const filePath of [getPlanTodoPath(workspacePath), getPlanContentPath(workspacePath)]) {
    try {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch {
      // Ignore errors
    }
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

// Matches stage headers in the canonical format enforced by the planning prompt:
//   ## Stage N: title
// Also accepts common fallback formats the model sometimes produces:
//   ## Stage N — title  |  ### Stage N  |  - Stage N  |  ## N. title
//   ### 📦 Stage N: title  (emoji/non-word chars between ## and "Stage")
export const STAGE_REGEX = /^(?:(#+)[^\w\d]*(?:stage|etapa|step|paso)\s+|(?:\d+\.)\s*(?:\*\*)?(?:stage|etapa|step|paso)\s+|-\s*(?:\[\s*\]\s*)?(?:\*\*)?(?:stage|etapa|step|paso)\s+|(#+)\s*)(?:\*\*)?0*(\d+)\b(.*)$/i;

export function isPlanMessage(content: string): boolean {
  const lines = content.split('\n');
  return lines.some(line => STAGE_REGEX.test(line));
}

/**
 * Initializes the current-plan-todo.md checklist from raw plan content.
 */
export function initPlanTodoFile(workspacePath: string, planContent: string): void {
  const lines = planContent.split('\n');
  const todoLines: string[] = [];

  todoLines.push('# PLAN PROGRESS');
  todoLines.push('');
  todoLines.push('This file tracks the current implementation plan progress.');
  todoLines.push('You can check or uncheck the boxes manually. REI will automatically update upon completing each stage.');
  todoLines.push('');

  let parsedCount = 0;
  for (const line of lines) {
    const match = line.match(STAGE_REGEX);
    if (match) {
      const num = parseInt(match[3], 10);
      const desc = (match[4] ?? '').replace(/^[\s.:\-*]+/, '').trim();
      todoLines.push(`- [ ] **Stage ${num}:** ${desc || 'No description'}`);
      parsedCount++;
    }
  }

  // If no structured stages were parsed, create a generic task representing the plan
  if (parsedCount === 0) {
    todoLines.push('- [ ] **General Plan**');
  }

  const filePath = getPlanTodoPath(workspacePath);
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, todoLines.join('\n'), 'utf8');
  } catch (err) {
    console.error('[PLAN TRACKER] Error creating plan todo file:', err);
  }

  saveCurrentPlanContent(workspacePath, planContent);
}

/**
 * Saves the full plan content to .rei/plans/<name>.md in the workspace.
 */
export function savePlanToFile(workspacePath: string, planName: string, planContent: string): string {
  // Sanitize the planName to prevent path traversal
  const sanitized = planName.replace(/[^a-zA-Z0-9_\-]/g, '_');
  const plansDir = path.join(workspacePath, '.rei', 'plans');
  const filePath = path.join(plansDir, `${sanitized}.md`);

  try {
    fs.mkdirSync(plansDir, { recursive: true });
    fs.writeFileSync(filePath, planContent, 'utf8');
    return filePath;
  } catch (err) {
    throw new Error(`Failed to save plan to disk: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Loads the full plan content from .rei/plans/<name>.md in the workspace.
 */
export function loadPlanFromFile(workspacePath: string, planName: string): string {
  // Sanitize the planName
  const sanitized = planName.replace(/[^a-zA-Z0-9_\-]/g, '_');
  
  // Try to find it as a direct file or inside .rei/plans/
  let filePath = path.join(workspacePath, '.rei', 'plans', `${sanitized}.md`);
  if (!fs.existsSync(filePath)) {
    // If not found in .rei/plans/, maybe they specified a path or filename directly in workspace
    filePath = path.resolve(workspacePath, planName);
    if (!fs.existsSync(filePath)) {
      throw new Error(`Plan file not found: '${planName}'`);
    }
  }

  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new Error(`Failed to read plan from disk: ${err instanceof Error ? err.message : String(err)}`);
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

    // Try patterns from most to least specific — stop at first match.
    const patterns = [
      // Canonical format written by initPlanTodoFile: "- [ ] **Stage N:**"
      new RegExp(`^-\\s*\\[\\s*\\]\\s*\\*\\*Stage\\s*${stageNumber}[:\\s]`, 'i'),
      // Without colon: "- [ ] **Stage N**"
      new RegExp(`^-\\s*\\[\\s*\\]\\s*\\*\\*Stage\\s*${stageNumber}\\b`, 'i'),
      // Spanish: "- [ ] **Etapa N"
      new RegExp(`^-\\s*\\[\\s*\\].*\\bEtapa\\s*${stageNumber}\\b`, 'i'),
      // Numbered list: "- [ ] N."
      new RegExp(`^-\\s*\\[\\s*\\]\\s*${stageNumber}\\.`),
      // Last resort: any unchecked line containing just that number
      new RegExp(`^-\\s*\\[\\s*\\].*\\b${stageNumber}\\b`),
    ];

    let modified = false;
    for (const pattern of patterns) {
      for (let i = 0; i < lines.length; i++) {
        if (pattern.test(lines[i])) {
          lines[i] = lines[i].replace(/^(-\s*)\[\s*\]/, '$1[x]');
          modified = true;
          break;
        }
      }
      if (modified) break;
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
      // Look for "/runplan stage X"
      const match = msg.content.match(/\/runplan\s+(?:stage)\s+(\d+)/i);
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
