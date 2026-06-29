import type { AgentSREdit } from "../../contracts/agent-interaction.types.js";

/**
 * Builds a human-readable failure report when the agent loop exhausts the turn limit without
 * producing valid edits. Explains what happened and gives actionable suggestions. Extracted from
 * generator.ts (Phase 3) — used by both XML agent paths and the SR-edit handler.
 */
export function buildMaxTurnsFailureMessage(params: {
  loopCount: number;
  maxTurns: number;
  firstTurnExplanation: string;
  lastValidationError: string;
  failedEdits: AgentSREdit[];
}): string {
  const {
    loopCount,
    maxTurns,
    firstTurnExplanation,
    lastValidationError,
    failedEdits,
  } = params;

  const lines: string[] = [
    `⚠️ REI could not complete the task after ${loopCount} attempts.`,
    "",
  ];

  if (firstTurnExplanation) {
    lines.push("**What was planned:**");
    lines.push(firstTurnExplanation);
    lines.push("");
  }

  if (lastValidationError) {
    lines.push("**Why it failed:**");
    lines.push(lastValidationError);
    lines.push("");
  }

  if (failedEdits.length > 0) {
    const files = [...new Set(failedEdits.map((e) => e.file))];
    lines.push(`**Files involved:** ${files.join(", ")}`);
    lines.push("");
  }

  lines.push("**What to try next:**");
  lines.push('- Ask REI to re-read the files first: *"Read [file] and retry"*');
  lines.push(
    "- Switch to wholefile mode: set `AGENT_EDIT_FORMAT=wholefile` in your .env",
  );
  if (loopCount >= maxTurns) {
    lines.push(
      `- Increase the turn limit: set \`REI_MAX_TURNS=${maxTurns + 3}\` in your .env`,
    );
  }

  return lines.join("\n");
}
