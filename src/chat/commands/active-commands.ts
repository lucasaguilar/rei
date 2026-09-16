import * as fs from "node:fs";
import * as path from "node:path";
import type { CommandHandler, CommandResult } from "./command-handler.js";
import { clearActive, getActive } from "../active-artifacts.js";

/**
 * `/active` — what the SDD flow is currently pointed at, and how to point it elsewhere.
 *
 * The active spec/plan is deliberately sticky: finishing a plan does not clear it, because re-running
 * a stage is normal. The hazard is the other end — a pointer left set after a feature is done, so a
 * later `/runplan` executes the OLD plan against new work. Being able to see it and clear it is what
 * makes stickiness safe.
 */
const ACTIVE_RE = /^\/active(?:\s+(clear|off)(?:\s+(spec|plan))?)?$/i;
/**
 * Anything else starting with `/active`. The help line reads `/active [clear]`, and a bracketed
 * placeholder is what a reader copies — so `/active [clear]` was answered with "Unknown command",
 * which says the command does not exist when the truth is that the argument was quoted from its own
 * usage. Tab-completion strips the brackets; a human reading /help does not.
 */
const ACTIVE_ANY_RE = /^\/active\b/i;

function describe(workspacePath: string): string {
  const { spec, plan } = getActive(workspacePath);
  if (!spec && !plan) return "[REI] Nothing active. /spec <task> starts a new one.";

  const line = (label: string, name: string | undefined, dir: string): string => {
    if (!name) return `  ${label}: (none)`;
    const file = path.join(workspacePath, ".rei", dir, `${name}.md`);
    // A pointer can outlive the file it names — say so instead of failing later at /runplan.
    const missing = fs.existsSync(file) ? "" : "   ⚠ file missing";
    return `  ${label}: ${name}   (.rei/${dir}/${name}.md)${missing}`;
  };

  return (
    `[REI] Active:\n${line("spec", spec, "specs")}\n${line("plan", plan, "plans")}\n` +
    `  /active clear [spec|plan] to unset`
  );
}

export const activeCommands: CommandHandler = {
  match: (c) => ACTIVE_ANY_RE.test(c.trim()),

  run: ({ command, workspacePath }): CommandResult => {
    const trimmed = command.trim();
    if (!ACTIVE_RE.test(trimmed)) {
      return {
        success: false,
        recordInSession: false,
        response:
          `[REI] Usage: /active · /active clear · /active clear spec · /active clear plan\n` +
          `  (the square brackets in the help line mean "optional" — they are not typed)\n` +
          `${describe(workspacePath)}`,
      };
    }
    const m = trimmed.match(ACTIVE_RE);
    const clearing = m?.[1];
    if (!clearing) {
      return { success: true, recordInSession: false, response: describe(workspacePath) };
    }
    const what = (m?.[2] as "spec" | "plan" | undefined) ?? "both";
    clearActive(workspacePath, what);
    return {
      success: true,
      recordInSession: false,
      response:
        `[REI] Cleared the active ${what === "both" ? "spec and plan" : what}.\n` +
        `${describe(workspacePath)}`,
    };
  },
};
