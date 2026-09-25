/**
 * @fileoverview Keeping `<workspace>/.rei` out of the user's commits.
 *
 * REI stores its per-project state inside the repository it was opened in: the wizard's `.env` (API
 * keys), the session logs (every prompt and every patch), specs and plans. That is convenient and
 * versionable for the parts a team wants to share — and a leak for the parts it does not.
 *
 * The directory therefore ignores itself with a nested `.gitignore` holding `*`. It is applied from
 * that directory down, needs no cooperation from the project's own ignore file, and does not require
 * REI to edit a file that belongs to the user. Anyone who wants a spec or a rules file tracked
 * negates it there — an explicit decision, which is the point.
 *
 * `scripts/launch-rei.js` does the same thing for the `.env` it writes before REI even starts; it
 * cannot import this module (it ships standalone to ~/.rei/scripts), so the rule lives in both and
 * `rei-dir.test.ts` pins the contents they must agree on.
 *
 * @module rei/workspace/rei-dir
 */

import * as fs from "node:fs";
import * as path from "node:path";

/** What the nested ignore file says. Exported so the wizard's copy can be checked against it. */
export const REI_DIR_GITIGNORE =
  "# Written by REI: this directory holds API keys and session state.\n*\n";

/**
 * Creates `<workspacePath>/.rei/.gitignore` when it is absent.
 *
 * Never overwrites: a user may have narrowed it deliberately (tracking `.rei/rules.md`, say).
 * Best-effort — a read-only or unwritable directory must not take the session down with it.
 */
export function ensureReiDirIgnored(workspacePath: string): void {
  try {
    const reiDir = path.join(workspacePath, ".rei");
    if (!fs.existsSync(reiDir)) return; // nothing created yet — nothing to hide
    const ignorePath = path.join(reiDir, ".gitignore");
    if (fs.existsSync(ignorePath)) return;
    fs.writeFileSync(ignorePath, REI_DIR_GITIGNORE, "utf8");
  } catch {
    /* best effort: never fail a turn over an ignore file */
  }
}
