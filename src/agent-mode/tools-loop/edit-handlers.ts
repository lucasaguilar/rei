import * as fs from "fs/promises";
import * as path from "path";
import type { AgentSREdit } from "../../contracts/agent-interaction.types.js";
import type { AgentLogger } from "../../core/logger.js";
import { resolveWorkspacePath } from "../../workspace/file-security.js";

export interface EditTask {
  callId: string;
  edit: AgentSREdit;
  /** rewrite_file: `edit.replace` is the authoritative full content (no search matching). */
  wholeFile?: boolean;
}

/** What an edit handler produces back to the loop. Edits accumulate in ctx.editTasks; created
 *  files in ctx.createdFiles — both mutated by reference. */
export interface EditOutcome {
  /** Set into toolResultsMap when present (e.g. a validation error, or "OK: created"). */
  toolResult?: string;
  /** OR'd into the loop's hasToolFailure flag. */
  failed?: boolean;
}

export interface EditHandlerContext {
  workspacePath: string;
  logger: AgentLogger;
  emitStatus: (msg: string) => void;
  /** Normalize + enforce workspace containment (throws for missing/escaping paths). */
  resolveTarget: (raw: unknown) => string;
  /** Queued search→replace edits (mutated). */
  editTasks: EditTask[];
  /** Files written directly this turn (mutated). */
  createdFiles: string[];
}

/**
 * edit_file: queue a search→replace edit. Validates args up front — a missing search/replace would
 * crash the apply with `undefined.replace`, so return a precise error for the model to retry.
 * Extracted from executeAgentTurnWithTools (Phase 2).
 */
export function handleEditFile(
  args: Record<string, unknown>,
  callId: string,
  ctx: EditHandlerContext,
): EditOutcome {
  const file = ctx.resolveTarget(args.file);
  if (typeof args.search !== "string" || typeof args.replace !== "string") {
    const missing = [
      typeof args.search !== "string" ? "search" : null,
      typeof args.replace !== "string" ? "replace" : null,
    ]
      .filter(Boolean)
      .join(" and ");
    return {
      toolResult:
        `ERROR: edit_file to ${file} is missing the "${missing}" argument. ` +
        `Both "search" (exact text to find) and "replace" (new text) are required strings. ` +
        `Re-send this edit_file call with both fields filled in (keep using edit_file — ` +
        `do NOT switch to rewriting the whole file).`,
      failed: true,
    };
  }
  const edit: AgentSREdit = { file, search: args.search, replace: args.replace };
  ctx.logger.logInfo(`[tools] edit_file: ${edit.file}`);
  ctx.emitStatus(`🛠️  [REI] Editing: ${edit.file}`);
  ctx.editTasks.push({ callId, edit });
  return {};
}

/**
 * rewrite_file: whole-file overwrite. REI fills `search` with the EXACT current disk content so the
 * model never reproduces it (sidesteps search-mismatch). New files are written directly (like
 * create_file); existing ones go through the edit pipeline as an authoritative whole-file replace.
 */
export async function handleRewriteFile(
  args: Record<string, unknown>,
  callId: string,
  ctx: EditHandlerContext,
): Promise<EditOutcome> {
  const file = ctx.resolveTarget(args.file);
  const newContent = (args.content as string) ?? "";
  const absPath = resolveWorkspacePath(file, ctx.workspacePath);
  const current = await fs.readFile(absPath, "utf-8").catch(() => null);
  ctx.logger.logInfo(`[tools] rewrite_file: ${file}`);
  ctx.emitStatus(`📝  [REI] Rewriting whole file: ${file}`);
  if (current === null) {
    // Doesn't exist yet — just write it (like create_file).
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    await fs.writeFile(absPath, newContent, "utf-8");
    ctx.createdFiles.push(file);
    return { toolResult: `OK: ${file} created` };
  }
  // Authoritative whole-file overwrite — REPLACES accumulated content (no search matching, so it
  // can't "poison" later edits).
  ctx.editTasks.push({
    callId,
    edit: { file, search: current, replace: newContent },
    wholeFile: true,
  });
  return {};
}

/** create_file: write a NEW file; skip (with guidance) if it already exists. */
export async function handleCreateFile(
  args: Record<string, unknown>,
  ctx: EditHandlerContext,
): Promise<EditOutcome> {
  const file = ctx.resolveTarget(args.file);
  const filePath = resolveWorkspacePath(file, ctx.workspacePath);
  const exists = await fs
    .stat(filePath)
    .then(() => true)
    .catch(() => false);
  ctx.emitStatus(`📂  [REI] Creating: ${file}`);
  if (exists) {
    return {
      toolResult: `SKIPPED: ${file} already exists — use edit_file to modify it (or rewrite_file to overwrite it entirely)`,
    };
  }
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, args.content as string, "utf-8");
  ctx.logger.logInfo(`[tools] create_file: ${file}`);
  ctx.createdFiles.push(file);
  return { toolResult: `OK: ${file} created` };
}
