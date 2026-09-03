/**
 * @fileoverview Which spec and plan the SDD flow is currently working on.
 *
 * The state used to live in four places with no clear owner: named files under `.rei/specs/` and
 * `.rei/plans/` (durable but inert — nothing read them unless you re-loaded them by hand), a copy in
 * `.rei/current-plan-content.md` (written as a side effect of /runplan, read as its fallback, AND a
 * live dependency for stage counting), and the session transcript (the actual primary source, chosen
 * by the heuristic "the newest message containing a `## Stage N` line").
 *
 * The weakest of the four won: any message that merely QUOTED a plan — a recap, a summary — outranked
 * the plan saved to disk. Saving a plan did not make it the one that ran, and the mismatch surfaced
 * only as "Stage 1 was not found".
 *
 * This is the owner: a pointer, not a copy. It records the NAME of the active spec and plan, so there
 * is nothing to go stale against the file it points at. It lives on disk rather than in ChatSession
 * because session fields are in-memory only (`saveSession` persists messages/mode/summary and nothing
 * else), and losing the active plan on restart is exactly the friction this removes.
 *
 * @module rei/chat/active-artifacts
 */

import * as fs from "node:fs";
import * as path from "node:path";

const ACTIVE_FILE = ".rei/active.json";

export interface ActiveArtifacts {
  /** Name of the active spec, as stored under `.rei/specs/<name>.md`. */
  spec?: string;
  /** Name of the active plan, as stored under `.rei/plans/<name>.md`. */
  plan?: string;
}

function activePath(workspacePath: string): string {
  return path.join(workspacePath, ACTIVE_FILE);
}

/** The active spec/plan names, or an empty object when nothing is set (or the file is unreadable). */
export function getActive(workspacePath: string): ActiveArtifacts {
  try {
    const raw = fs.readFileSync(activePath(workspacePath), "utf8");
    const parsed = JSON.parse(raw) as ActiveArtifacts;
    return {
      spec: typeof parsed.spec === "string" ? parsed.spec : undefined,
      plan: typeof parsed.plan === "string" ? parsed.plan : undefined,
    };
  } catch {
    return {}; // absent or malformed → nothing is active, which is a valid state
  }
}

/** Merges `patch` into the stored pointer. Never throws: losing the pointer must not fail a command. */
function update(workspacePath: string, patch: ActiveArtifacts): void {
  const next = { ...getActive(workspacePath), ...patch };
  try {
    fs.mkdirSync(path.dirname(activePath(workspacePath)), { recursive: true });
    fs.writeFileSync(activePath(workspacePath), JSON.stringify(next, null, 2) + "\n", "utf8");
  } catch {
    /* best-effort: the command's real work already succeeded */
  }
}

export function setActiveSpec(workspacePath: string, name: string): void {
  update(workspacePath, { spec: name });
}

export function setActivePlan(workspacePath: string, name: string): void {
  update(workspacePath, { plan: name });
}

/** Absolute path of the active plan's file, or null when none is set or the file is gone. */
export function activePlanPath(workspacePath: string): string | null {
  const { plan } = getActive(workspacePath);
  if (!plan) return null;
  const file = path.join(workspacePath, ".rei", "plans", `${plan}.md`);
  return fs.existsSync(file) ? file : null;
}

/** Content of the active plan, or null when there is none. */
export function readActivePlan(workspacePath: string): string | null {
  const file = activePlanPath(workspacePath);
  if (!file) return null;
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}
