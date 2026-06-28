import type { AgentLogger } from "../../core/logger.js";
import type { MismatchEscalation } from "./apply-edit-batch.js";

/**
 * Builds the user message that escalates against the search-mismatch death-loop (extracted from
 * executeAgentTurnWithTools — Phase 2). Two tiers:
 *  - "inject": hand the model the exact current content so it can copy the `search` block verbatim.
 *  - "wholefile": it still can't match — tell it to stop using edit_file and overwrite the whole
 *    file via rewrite_file (no exact-match requirement).
 * The caller pushes the returned string as a user message.
 */
export async function buildMismatchEscalationMessage(
  escalation: MismatchEscalation,
  ctx: {
    logger: AgentLogger;
    emitStatus: (msg: string) => void;
    /** Working content (pending virtual edits if any), not stale disk. */
    currentContent: (file: string) => Promise<string>;
  },
): Promise<string> {
  const { files, mode } = escalation;

  if (mode === "inject") {
    ctx.logger.logInfo(
      `[tools] auto-injecting file context after repeated search mismatches: ${files.join(", ")}`,
    );
    ctx.emitStatus(`📄  [REI] Re-sending exact file content so edits match: ${files.join(", ")}`);
    const contextMessage =
      "\n" +
      (
        await Promise.all(
          files.map(
            async (f) => `--- File: ${f} ---\n\`\`\`\n${await ctx.currentContent(f)}\n\`\`\``,
          ),
        )
      ).join("\n\n");
    return (
      "Your edit_file `search` blocks did NOT match the file content exactly. " +
      "Below is the current, exact content of the file(s). Copy the `search` text " +
      "VERBATIM from here (including indentation and whitespace), then retry edit_file:\n" +
      contextMessage
    );
  }

  ctx.logger.logInfo(
    `[tools] escalating to whole-file rewrite after persistent mismatches: ${files.join(", ")}`,
  );
  ctx.emitStatus(
    `🔁  [REI] edit_file keeps failing — switching to whole-file rewrite: ${files.join(", ")}`,
  );
  return (
    `edit_file keeps failing to match the search block for ${files.join(", ")}. ` +
    "STOP using edit_file for these file(s). Instead call `rewrite_file` with the " +
    "file path and its COMPLETE corrected content — you do not need to match any " +
    "search text. Use the exact file content shown above as your starting point."
  );
}
