import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ChatMessage } from './types.js';

// The active plan's content — the SOURCE fallback for /runplan when the session
// has no in-memory plan (e.g. cross-session). There is intentionally NO progress
// checklist (`current-plan-todo.md` was removed): the agent executes plans
// holistically, not stage-by-stage in lockstep, so a per-stage checklist drifted
// from reality and added complexity without value. "Done" is the code + verify.
const PLAN_CONTENT_FILE = '.rei/current-plan-content.md';

function getPlanContentPath(workspacePath: string): string {
  return path.join(workspacePath, PLAN_CONTENT_FILE);
}

export function getTotalStagesInPlan(workspacePath: string): number {
  const content = loadCurrentPlanContent(workspacePath);
  if (!content) return 0;
  const stageNums = new Set<number>();
  for (const line of content.split('\n')) {
    const m = line.match(STAGE_REGEX);
    if (m) stageNums.add(parseInt(m[3], 10));
  }
  return stageNums.size;
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
 * Clears the active plan (deletes current-plan-content.md). Called when a session
 * is reset/archived so a fresh session doesn't fall back to a stale plan.
 */
export function clearCurrentPlan(workspacePath: string): void {
  try {
    const filePath = getPlanContentPath(workspacePath);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {
    // Ignore errors
  }
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
 * Saves an auditor review to `.rei/plans/<name>.review.md` — next to its plan, so `@` and /loadplan
 * find it. Overwrites (a re-audit reflects the plan's current state). See docs/roles-spec.md.
 */
export function saveReviewToFile(workspacePath: string, name: string, content: string): string {
  const sanitized = name.replace(/[^a-zA-Z0-9_\-]/g, '_');
  const plansDir = path.join(workspacePath, '.rei', 'plans');
  const filePath = path.join(plansDir, `${sanitized}.review.md`);
  try {
    fs.mkdirSync(plansDir, { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
    return filePath;
  } catch (err) {
    throw new Error(`Failed to save review to disk: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** True when an assistant message looks like an auditor review (exec summary / verdict / risks+blind-spots). */
export function isReviewMessage(content: string): boolean {
  return (
    /executive summary/i.test(content) ||
    /needs critical fixes|approved with observations|unviable/i.test(content) ||
    (/\brisks?\b/i.test(content) && /blind spot/i.test(content))
  );
}

/**
 * Loads the full plan content from .rei/plans/<name>.md in the workspace.
 */
export function loadPlanFromFile(workspacePath: string, planName: string): string {
  // Accept: a bare name (`my-plan`), a name with extension (`my-plan.md`), a workspace-relative path
  // (`.rei/plans/my-plan.md`), and any of those prefixed with `@` (the file-picker inserts `@<path>`).
  const input = planName.trim().replace(/^@/, "");

  const readOrNull = (p: string): string | null => {
    try {
      return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null;
    } catch {
      return null;
    }
  };

  // Looks like a PATH (has a separator) → resolve it directly under the workspace, with/without .md.
  // Don't sanitize here: the user gave an explicit path on purpose.
  if (input.includes("/") || input.includes("\\")) {
    const abs = path.resolve(workspacePath, input);
    const content = readOrNull(abs) ?? readOrNull(`${abs}.md`);
    if (content !== null) return content;
    throw new Error(`Plan file not found: '${planName}'`);
  }

  // A BARE name → .rei/plans/<sanitized>.md (drop an optional .md the user typed; sanitize the name
  // to avoid path traversal since it becomes part of a filename).
  const bare = input.replace(/\.md$/i, "");
  const sanitized = bare.replace(/[^a-zA-Z0-9_\-]/g, "_");
  const content = readOrNull(
    path.join(workspacePath, ".rei", "plans", `${sanitized}.md`),
  );
  if (content !== null) return content;
  throw new Error(`Plan file not found: '${planName}'`);
}

/**
 * Restores the active plan (current-plan-content.md) from the last plan message
 * in a loaded session, so /runplan's fallback and the stage count stay accurate
 * after resuming a session.
 */
export function restoreCurrentPlanFromSession(
  workspacePath: string,
  messages: ChatMessage[]
): void {
  const lastPlanMsg = [...messages]
    .reverse()
    .find(
      (m) =>
        m.role === 'assistant' &&
        m.content &&
        m.sourceMode !== 'agent' &&
        isPlanMessage(m.content)
    );

  if (lastPlanMsg?.content) {
    saveCurrentPlanContent(workspacePath, lastPlanMsg.content);
  } else {
    clearCurrentPlan(workspacePath);
  }
}
