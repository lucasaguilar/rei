import type { BatchPatchApplyResult } from "../../tools/patch-applier.js";
import { formatCodeDiff } from "../../cli/markdown-renderer.js";
import { paint } from "../../cli/theme/palette.js";

/**
 * Formats the feedback report from applying a batch of Search-and-Replace edits to the filesystem.
 */
export function formatBatchPatchResult(result: BatchPatchApplyResult): string {
  const header = result.success
    ? `\n\n---\n\u001b[32m\u001b[1m${result.results.length} patch(es) applied directly.\u001b[0m`
    : `\n\n---\n\u001b[31m\u001b[1mSome patches failed to apply.\u001b[0m`;

  const details = result.results
    .map(
      (r) =>
        `\n- ${r.file}: ${r.applied ? "applied" : r.skipped ? "skipped" : "failed"}`,
    )
    .join("");

  return header + details;
}

/**
 * The diff shown for one applied edit, under a "File:" label the server's chat handler keys on.
 * No ```diff fence: the CLI prints this live, not through the markdown renderer, so the fence
 * reached the screen as literal backticks — and the server wraps it in a fence of its own.
 */
export function formatAppliedEditDiff(file: string, search: string, replace: string): string {
  return `\n${paint("strong", "File:")} ${file}\n${formatCodeDiff(search, replace)}`;
}
