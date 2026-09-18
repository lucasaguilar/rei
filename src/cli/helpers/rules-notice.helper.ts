import * as fs from "fs";
import * as path from "path";
import { detectProjectType } from "../../workspace/project-type.js";

/**
 * The one-time notice for a project that USED to get its stack rules for free.
 *
 * REI shipped a hardcoded Angular ruleset and injected it into every turn of any workspace it
 * detected as Angular. Removing it is right — the repo owns its rules — but for a project that was
 * relying on it, removal is silent: nothing breaks, the model just quietly starts writing `*ngIf`
 * again. So REI says it once, where it can still be acted on, instead of letting it be discovered
 * in a review weeks later.
 *
 * Deliberately narrow: only when the stack has a template, and only when the workspace has NO
 * rules file at all. A project that wrote its own rules has already answered this question, and
 * REI does not get to grade the answer.
 */
export function rulesMigrationNotice(
  workspacePath: string,
  templatesRoot: string,
): string | null {
  if (fs.existsSync(path.join(workspacePath, ".rei", "rules.md"))) return null;

  let type: string;
  try {
    type = detectProjectType(workspacePath).type;
  } catch {
    return null;
  }
  if (!fs.existsSync(path.join(templatesRoot, `${type}.md`))) return null;

  return (
    `[REI] This looks like a ${type} project with no .rei/rules.md. ` +
    `REI no longer ships rules for any stack — they belong to the repo. ` +
    `Run '/rules install ${type}' to start from the ${type} ruleset.`
  );
}
