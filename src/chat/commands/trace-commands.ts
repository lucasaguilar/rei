import * as fs from "node:fs";
import * as path from "node:path";
import type { CommandHandler, CommandResult } from "./command-handler.js";
import { getActive } from "../active-artifacts.js";
import {
  checkScope,
  formatScopeReport,
  formatTraceReport,
  traceSpecToPlan,
} from "../sdd-trace.js";

/**
 * `/trace` — does the plan still match the spec it was built from?
 *
 * The SDD flow only runs forward, so a discovery made while implementing never travels back to the
 * spec. This crosses the two documents deterministically, both ways, and reports the disagreements
 * before `verify-against-spec` turns them into a wrong verdict.
 */
const TRACE_RE = /^\/trace(?:\s+(\S+)\s+(\S+))?$/i;

function read(workspacePath: string, dir: string, name: string): string | null {
  const file = path.join(workspacePath, ".rei", dir, `${name}.md`);
  return fs.existsSync(file) ? fs.readFileSync(file, "utf-8") : null;
}

export const traceCommands: CommandHandler = {
  match: (c) => TRACE_RE.test(c.trim()),

  run: ({ command, workspacePath }): CommandResult => {
    const m = command.trim().match(TRACE_RE);
    const active = getActive(workspacePath);
    // Explicit names win; otherwise trace whatever the session is pointed at.
    const specName = m?.[1] ?? active.spec;
    const planName = m?.[2] ?? active.plan;

    if (!specName || !planName) {
      return {
        success: false,
        recordInSession: false,
        response:
          "[TRACE] Needs both a spec and a plan.\n" +
          `  active spec: ${active.spec ?? "(none)"}   active plan: ${active.plan ?? "(none)"}\n` +
          "  Set them with /spec + /decompose (or /loadspec + /loadplan), or pass them: /trace <spec> <plan>",
      };
    }

    const specText = read(workspacePath, "specs", specName);
    const planText = read(workspacePath, "plans", planName);
    const missing = [
      specText === null ? `.rei/specs/${specName}.md` : null,
      planText === null ? `.rei/plans/${planName}.md` : null,
    ].filter(Boolean);
    if (missing.length > 0) {
      return {
        success: false,
        recordInSession: false,
        response: `[TRACE] File not found: ${missing.join(", ")}`,
      };
    }

    const report = traceSpecToPlan(specText as string, planText as string);
    // Two independent checks over the same plan: criteria coverage, and whether the up-front file
    // inventory is grounded. A plan can trace perfectly to the spec and still name files that do
    // not exist.
    const scope = checkScope(planText as string, workspacePath);
    return {
      // A disagreement is a finding, not a command failure — the report is the deliverable.
      success: true,
      recordInSession: false,
      response:
        formatTraceReport(report, specName, planName) +
        "\n\n  ── Declared scope ──\n" +
        formatScopeReport(scope),
    };
  },
};
