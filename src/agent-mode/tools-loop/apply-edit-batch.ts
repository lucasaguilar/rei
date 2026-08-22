import type { AgentSREdit } from "../../contracts/agent-interaction.types.js";
import type { AgentLogger } from "../../core/logger.js";
import { applyFileEdits } from "../../tools/search-replace.js";
import { validateProposedPatches } from "../helpers/patch-helpers.js";
import type { EditTask } from "./edit-handlers.js";

// Beyond this size we don't inline a file's updated content back to the model (avoids bloating the
// tool result); the model can re-read it if it truly needs the exact state.
const MAX_INLINE_EDIT_RESULT_CHARS = 24000;

/**
 * After a successful apply, build each edit's tool result INCLUDING the file's updated content, so
 * the model can compose further edits without re-reading it. This kills the read-after-edit churn
 * (edit → read same file → edit → read again …) that multiplies model calls and dominates agent-turn
 * latency.
 */
export function setEditResults(
  editTasks: EditTask[],
  candidate: Map<string, string>,
  toolResultsMap: Map<string, string>,
): void {
  const inlined = new Set<string>();
  for (const task of editTasks) {
    const f = task.edit.file;
    const updated = candidate.get(f) ?? "";
    if (inlined.has(f)) {
      toolResultsMap.set(
        task.callId,
        `OK: another edit to ${f} applied (its updated content is shown above — do not re-read it).`,
      );
      continue;
    }
    inlined.add(f);
    if (updated.length <= MAX_INLINE_EDIT_RESULT_CHARS) {
      // The model now has the post-edit content inline in this result.
      toolResultsMap.set(
        task.callId,
        `OK: edit to ${f} applied. The file now contains exactly:\n\`\`\`\n${updated}\n\`\`\`\n` +
          `You already have ${f}'s current content above — do NOT call read_files on it again; ` +
          `compose any further edits against this content. Apply MULTIPLE edits at once by emitting ` +
          `several edit_file calls in ONE response (don't do one per turn). When ALL changes for the ` +
          `task are done, reply with a brief summary (no tool call).`,
      );
    } else {
      // Too large to inline; the model hasn't seen the new state (it can re-read if it needs it).
      toolResultsMap.set(
        task.callId,
        `OK: edit to ${f} applied to disk. (File is large — not inlined.) Avoid re-reading it ` +
          `unless you genuinely need its exact current state for another edit. When done, reply ` +
          `with a brief summary (no tool call).`,
      );
    }
  }
}

export interface MismatchEscalation {
  files: string[];
  mode: "inject" | "wholefile";
}

export interface BatchContext {
  workspacePath: string;
  loopCount: number;
  /** DIRECT mode applies to disk immediately (no per-edit compile check); SANDBOX validates first. */
  directMode: boolean;
  /** Current consecutive search-mismatch streak (in); the result carries the updated value. */
  mismatchStreak: number;
  injectAt: number;
  wholefileAt: number;
  logger: AgentLogger;
  virtualFiles: Map<string, string>;
  toolResultsMap: Map<string, string>;
  readDisk: (file: string) => Promise<string>;
  persistToDisk: (files: string[]) => Promise<void>;
}

export interface BatchOutcome {
  /** A search mismatch or a failed compile occurred (→ caller's hasToolFailure). */
  failed: boolean;
  /** Updated consecutive search-mismatch streak (→ caller's counter). */
  mismatchStreak: number;
  /** Set when the mismatch streak crossed a tier; the caller drives the escalation. */
  mismatchEscalation: MismatchEscalation | null;
}

/**
 * Applies a batch of queued edits to the virtual file tree, then either persists (direct mode) or
 * validates-then-persists (sandbox mode). Extracted from executeAgentTurnWithTools (Phase 2). The
 * maps in `ctx` (virtualFiles / toolResultsMap) are mutated by reference; the
 * loop-local failure flags + mismatch escalation are RETURNED for the caller to apply.
 */
export async function applyEditBatch(
  editTasks: EditTask[],
  ctx: BatchContext,
): Promise<BatchOutcome> {
  if (editTasks.length === 0) {
    return { failed: false, mismatchStreak: ctx.mismatchStreak, mismatchEscalation: null };
  }

  // Build the candidate tree: apply each edit on top of pending content (or disk).
  const candidate = new Map(ctx.virtualFiles);
  let mismatchFile: string | null = null;
  let mismatchError: string | null = null;
  for (const task of editTasks) {
    const f = task.edit.file;
    if (task.wholeFile) {
      candidate.set(f, task.edit.replace); // rewrite_file: authoritative content
      continue;
    }
    const base = candidate.has(f) ? candidate.get(f)! : await ctx.readDisk(f);
    const res = applyFileEdits(base, [task.edit]);
    if (!res.success) {
      mismatchFile = f;
      mismatchError = res.error ?? `Could not apply edit to ${f}`;
      break;
    }
    candidate.set(f, res.newContent!);
  }

  if (mismatchFile) {
    // Search block didn't match the working content → mismatch death-loop tracking.
    const mismatchStreak = ctx.mismatchStreak + 1;
    for (const task of editTasks) {
      ctx.toolResultsMap.set(task.callId, `ERROR: ${mismatchError}`);
    }
    const files = [mismatchFile];
    let mismatchEscalation: MismatchEscalation | null = null;
    if (mismatchStreak >= ctx.wholefileAt) {
      mismatchEscalation = { files, mode: "wholefile" };
    } else if (mismatchStreak === ctx.injectAt) {
      mismatchEscalation = { files, mode: "inject" };
    }
    return { failed: true, mismatchStreak, mismatchEscalation };
  }

  const editedFiles = [...new Set(editTasks.map((t) => t.edit.file))];

  if (ctx.directMode) {
    // DIRECT: apply to disk immediately with NO per-edit compile-check. The model verifies via
    // run_command (it sees the real disk) and REI does ONE final verify when it finishes.
    for (const [f, c] of candidate) ctx.virtualFiles.set(f, c);
    await ctx.persistToDisk(editedFiles);
    setEditResults(editTasks, candidate, ctx.toolResultsMap);
    return { failed: false, mismatchStreak: 0, mismatchEscalation: null };
  }

  // SANDBOX: validate the CUMULATIVE virtual tree (compile check), expressed as whole-file rewrites
  // from disk (search = exact disk content, never mismatches in the sandbox). Persist only green.
  const candidateEdits: AgentSREdit[] = [];
  for (const [f, c] of candidate) {
    candidateEdits.push({ file: f, search: await ctx.readDisk(f), replace: c });
  }
  const validation = await validateProposedPatches({
    workspacePath: ctx.workspacePath,
    edits: candidateEdits,
    loopCount: ctx.loopCount,
    logger: ctx.logger,
  });

  if (validation.success) {
    for (const [f, c] of candidate) ctx.virtualFiles.set(f, c); // commit to virtual tree
    // Persist on-green so the model's OWN run_command (ngc/head/tests) sees its work.
    await ctx.persistToDisk(editedFiles);
    setEditResults(editTasks, candidate, ctx.toolResultsMap);
    return { failed: false, mismatchStreak: 0, mismatchEscalation: null };
  }

  // Compile error (not a search mismatch) → reset the mismatch streak.
  for (const task of editTasks) {
    ctx.toolResultsMap.set(
      task.callId,
      `ERROR: ${validation.feedback ?? "combined changes do not compile"}`,
    );
  }
  return { failed: true, mismatchStreak: 0, mismatchEscalation: null };
}
