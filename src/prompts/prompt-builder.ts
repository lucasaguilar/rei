import type { SessionMode } from "../chat/types.js";
import { loadLocalRules, loadPrompt } from "./loader.js";

export type AgentEditFormat = "sr" | "wholefile";

export function getAgentEditFormat(): AgentEditFormat {
  const val = (process.env.AGENT_EDIT_FORMAT ?? "sr").toLowerCase().trim();
  return val === "wholefile" ? "wholefile" : "sr";
}


/**
 * REI ships NO rules about your stack.
 *
 * There used to be an `ANGULAR_RULES` constant here, injected into every turn of any workspace
 * detected as Angular. It was the tool having an opinion about the user's code: arbitrary (rules
 * for Angular and for no other stack REI supports), invisible (nothing on screen said those 287
 * tokens were being sent), frozen (pinned to whatever Angular looked like the day it was written)
 * and duplicated (a project with its own conventions received both copies).
 *
 * Rules now come from ONE place, the repo that owns them: `<workspace>/.rei/rules.md`, versioned
 * with the code, editable by the people who wrote it. `/rules install angular` writes the same
 * ruleset THERE, as a starting point to edit rather than a constant to inherit.
 */
export function buildSystemMessage(
  mode: SessionMode,
  workspacePath?: string,
  roleBody?: string,
): string {
  // Current date — the model has a training cutoff and otherwise hallucinates
  // "today", breaking date-relative tasks (e.g. "today's emails", "last week").
  const now = new Date();
  const isoDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const weekday = now.toLocaleDateString("en-US", { weekday: "long" });
  const currentDateLine = `Current date: ${weekday}, ${isoDate} (user's local time). Use this for any date-relative request; do not guess the date.`;

  const sections: string[] = [
    loadPrompt("shared/base"),
    "",
    // Active role posture (auditor, security, …) — high priority, right after the base identity so it
    // overrides the default helpful/agreeable stance. See docs/roles-spec.md.
    ...(roleBody ? [`## ACTIVE ROLE (overrides default posture)\n${roleBody}`, ""] : []),
    loadPrompt("shared/personality"),
    "",
    currentDateLine,
    "",
    `Active mode: ${mode}`,
    "",
    loadPrompt("shared/response-rules"),
    "",
    // The workspace's own rules — the only stack rules REI sends (see above).
    loadLocalRules(workspacePath),
    "",
  ];

  // Native function-calling is the only engine (the XML interception path was removed), so every
  // mode uses its `*-tools` prompt: native read_files/run_command/edit_file tool calls, NO XML tags.
  // For agent, the tool prompt + its tool-format; for ask/planning, the tool prompt + the
  // tool-agnostic response-format prompt. Skills ride as the native `use_skill` tool (from
  // setupToolSelection), so no XML `<call_tool>` skill catalog is injected.
  if (mode === "agent") {
    sections.push(loadPrompt("modes/agent-tools"), "");
    sections.push(loadPrompt("formats/agent-format-tools"));
  } else {
    sections.push(loadPrompt(`modes/${mode}-tools`), "");
    sections.push(loadPrompt(`formats/${mode}-format`));
  }

  return sections.join("\n");
}
