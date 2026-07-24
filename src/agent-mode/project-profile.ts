import * as fs from "fs";
import * as path from "path";

/**
 * A compact "project profile" injected into an isolated sub-agent's fresh context so it follows the
 * project's conventions WITHOUT inheriting the orchestrator's dirty history. The isolation that
 * strips the noise also strips useful project facts (a worker once wrote CommonJS `require` in an ESM
 * repo because it couldn't see `package.json`); this restores just the facts, scalably per-project.
 *
 * Three sources (like Pi / gentle-ai): AUTO-derived overview (module system, language, commands) +
 * curated rules files (AGENTS.md / CLAUDE.md — the industry standard) + REI's own `.rei/rules.md`.
 * See docs/sub-agent-spec.md.
 */

const RULES_FILES = ["AGENTS.md", "CLAUDE.md", ".rei/rules.md"];
const MAX_RULES_CHARS = 4000; // cap so curated rules never bloat the fresh worker context

/** Auto-detected structural facts — scales to any repo with zero maintenance. */
function deriveOverview(workspacePath: string): string {
  const lines: string[] = [];
  try {
    const pkgPath = path.join(workspacePath, "package.json");
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as {
        type?: string;
        scripts?: Record<string, string>;
      };
      const esm = pkg.type === "module";
      lines.push(
        `- Module system: ${esm ? "ESM — use \`import\`/\`export\`, NOT \`require\`/\`module.exports\`" : "CommonJS — use \`require\`/\`module.exports\`"} ` +
          `(package.json "type": ${JSON.stringify(pkg.type ?? "commonjs")}).`,
      );
      if (pkg.scripts?.test) lines.push("- Test command: `npm test`.");
      if (pkg.scripts?.build) lines.push("- Build command: `npm run build`.");
    }
  } catch {
    // malformed/absent package.json → skip the overview facts
  }
  if (fs.existsSync(path.join(workspacePath, "tsconfig.json"))) {
    lines.push("- Language: TypeScript (tsconfig.json present) — write typed code.");
  }
  return lines.length > 0 ? `Overview (auto-detected):\n${lines.join("\n")}` : "";
}

/** Curated rules files (AGENTS.md / CLAUDE.md / .rei/rules.md), concatenated within a char budget. */
function readRules(workspacePath: string): string {
  const chunks: string[] = [];
  let budget = MAX_RULES_CHARS;
  for (const rel of RULES_FILES) {
    if (budget <= 0) break;
    try {
      const p = path.join(workspacePath, rel);
      if (!fs.existsSync(p)) continue;
      const content = fs.readFileSync(p, "utf8").trim();
      if (!content) continue;
      const slice = content.slice(0, budget);
      chunks.push(`From ${rel}:\n${slice}`);
      budget -= slice.length;
    } catch {
      // unreadable → skip this file
    }
  }
  return chunks.join("\n\n");
}

/** Builds the project-conventions block for a sub-agent, or "" when there's nothing to say. */
export function buildProjectProfile(workspacePath: string): string {
  const parts = [deriveOverview(workspacePath), readRules(workspacePath)].filter(
    (p) => p.length > 0,
  );
  if (parts.length === 0) return "";
  return `## Project conventions (MATCH these — the repo's rules override generic idioms)\n${parts.join("\n\n")}`;
}
