import * as fs from "fs";
import * as path from "path";
import { listRoles } from "./role-loader.js";

/**
 * Creating a role from the CLI.
 *
 * Lives next to role-loader on purpose: the template below is the parser's format written out, and
 * the two drift the moment they are apart. Anything the template shows must be something
 * `parseRole` reads.
 */

/** A role name that is safe as a filename AND invocable as `/<name>`. */
const NAME_RE = /^[a-z][a-z0-9-]{0,39}$/;

export interface ScaffoldResult {
  ok: boolean;
  /** Workspace-relative path of the file created, when one was. */
  file?: string;
  error?: string;
}

/**
 * The starting role file.
 *
 * Optional fields are present but COMMENTED OUT rather than omitted: a field you can see and
 * uncomment is discoverable, and one you have to read the docs to learn about is not. The parser
 * matches `^\s*<key>:`, so a leading `#` is ignored by it — the comments cannot accidentally take
 * effect.
 */
export function roleTemplate(name: string): string {
  return `---
name: ${name}
description: One line — it is what /roles shows and what the palette completes on.
# Permission profile this role borrows: ask (read-only) | planning (specs, plans, docs) | agent (writes anywhere).
baseMode: planning
# The ONLY files this role may write. Narrows baseMode, never widens it. Uncomment to restrict.
# writeGlob: "*.${name}.md"
# Run this role on a different model than yours — a second opinion is worth more from a second model.
# preferredModel: gemma-4-26b-a4b
---

# Role: ${name}

Write the posture here. This body becomes the system prompt, so address the model directly.

## What you are
Say what it IS, in one or two sentences.

## Non-negotiables
- The rules it must not break. Be blunt; hedged instructions get hedged behaviour.

## Output
Say exactly what shape the answer takes — a table, a numbered list, a verdict line. A role that
does not pin its output down produces a different shape every run.
`;
}

/** Creates `.rei/roles/<name>.md`. Never overwrites: an existing role is edited, not regenerated. */
export function scaffoldRole(
  name: string,
  workspacePath: string,
  isReserved: (n: string) => boolean,
): ScaffoldResult {
  const clean = name.trim().toLowerCase();

  if (!NAME_RE.test(clean)) {
    return {
      ok: false,
      error:
        `'${name}' is not a usable role name. Use lowercase letters, digits and dashes, starting ` +
        `with a letter (e.g. security-reviewer) — the name is both the filename and the command.`,
    };
  }

  // A reserved name produces a role that can never be invoked: the built-in command wins dispatch.
  // Refusing now beats letting you write a whole posture and discover that later.
  if (isReserved(clean)) {
    return {
      ok: false,
      error: `'${clean}' is already a built-in REI command, so /${clean} would never reach the role. Pick another name.`,
    };
  }

  if (listRoles(workspacePath).some((r) => r.name.toLowerCase() === clean)) {
    return { ok: false, error: `Role '${clean}' already exists. Edit it instead of recreating it.` };
  }

  const dir = path.join(workspacePath, ".rei", "roles");
  const file = path.join(dir, `${clean}.md`);
  try {
    fs.mkdirSync(dir, { recursive: true });
    // wx: fail if it exists. listRoles above cannot see a file that is present but unparsable, and
    // clobbering one is not something a scaffold command should ever do.
    fs.writeFileSync(file, roleTemplate(clean), { flag: "wx" });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Could not create ${file}: ${detail}` };
  }

  return { ok: true, file: path.posix.join(".rei", "roles", `${clean}.md`) };
}
