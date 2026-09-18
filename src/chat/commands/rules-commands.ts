import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import type { CommandHandler, CommandResult } from "./command-handler.js";

export const RULES_TEMPLATES_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../templates/rules",
);

/**
 * `/rules [install <stack>]` — the workspace's coding rules.
 *
 * REI ships no rules about your stack. `<workspace>/.rei/rules.md` is the only file it reads, and
 * it belongs to the repo: versioned with the code, editable by whoever wrote it. This command
 * copies a starting ruleset INTO that file — it never injects one from REI's own source, which is
 * what the old hardcoded Angular block did.
 *
 * Rules are injected into every coding turn, so `/rules` also reports what that costs: a file
 * nobody reads is still a file the model reads, on every turn, forever.
 */
const RULES_RE = /^\/rules(?:\s+install\s+(\S+))?$/i;

/** ~3.7 chars per token, the same estimate the context gauge uses. */
const estimateTokens = (chars: number): number => Math.round(chars / 3.7);

function availableStacks(): string[] {
  try {
    return fs
      .readdirSync(RULES_TEMPLATES_ROOT)
      .filter((f) => f.endsWith(".md"))
      .map((f) => f.replace(/\.md$/, ""))
      .sort();
  } catch {
    return [];
  }
}

export const rulesCommands: CommandHandler = {
  match: (c) => RULES_RE.test(c.trim()),

  run: ({ command, workspacePath }): CommandResult => {
    const stack = command.trim().match(RULES_RE)?.[1]?.toLowerCase();
    const rulesPath = path.join(workspacePath, ".rei", "rules.md");
    const stacks = availableStacks();

    if (!stack) {
      const exists = fs.existsSync(rulesPath);
      const size = exists ? fs.statSync(rulesPath).size : 0;
      const cost = exists
        ? `  ${size.toLocaleString()} bytes ≈ ${estimateTokens(size).toLocaleString()} tokens, sent on EVERY coding turn.\n`
        : "";
      return {
        success: true,
        recordInSession: false,
        response:
          `[REI] Workspace rules: ${exists ? rulesPath : "none"}\n` +
          cost +
          `  Rules come from the repo, never from REI — nothing about your stack is built in.\n` +
          (stacks.length > 0
            ? `  /rules install <${stacks.join("|")}>  writes a starting ruleset into that file.`
            : `  No templates are available in this install.`),
      };
    }

    if (!stacks.includes(stack)) {
      return {
        success: false,
        recordInSession: false,
        response: `[REI] No ruleset template for '${stack}'. Available: ${stacks.join(", ") || "(none)"}.`,
      };
    }

    // Never clobber: the file is the user's, and it may hold rules that took a project to learn.
    if (fs.existsSync(rulesPath)) {
      return {
        success: false,
        recordInSession: false,
        response:
          `[REI] ${rulesPath} already exists — not overwriting it.\n` +
          `  Open it and paste what you want from ${path.join(RULES_TEMPLATES_ROOT, `${stack}.md`)}.`,
      };
    }

    try {
      const template = fs.readFileSync(path.join(RULES_TEMPLATES_ROOT, `${stack}.md`), "utf-8");
      fs.mkdirSync(path.dirname(rulesPath), { recursive: true });
      fs.writeFileSync(rulesPath, template, "utf-8");
      return {
        success: true,
        recordInSession: false,
        response:
          `[REI] Wrote the ${stack} ruleset to ${rulesPath} (≈${estimateTokens(template.length)} tokens per turn).\n` +
          `  It is yours now: edit it, commit it, delete what does not apply to this repo.`,
      };
    } catch (err) {
      return {
        success: false,
        recordInSession: false,
        response: `[REI] Could not write ${rulesPath}: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },
};
