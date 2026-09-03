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
  match: (c) => ACTIVE_RE.test(c.trim()),

  run: ({ command, workspacePath }): CommandResult => {
    const m = command.trim().match(ACTIVE_RE);
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
