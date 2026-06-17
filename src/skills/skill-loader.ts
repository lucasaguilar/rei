import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import type { ToolDefinition } from "../providers/model-provider.js";

/**
 * A "skill" is a reusable, task-specific recipe written in Markdown. Skills are
 * loaded on demand: only a lightweight catalog (name + description) is shown to
 * the model up front; the full body is injected ONLY when the model invokes the
 * `use_skill` meta-tool. This keeps the prompt lean — you can have many skills
 * without burning context, which matters for local models.
 *
 * Skills come from two places:
 *   1. Built-in:        <rei>/prompts/skills/*.md
 *   2. Per-workspace:   {workspace}/.rei/skills/*.md   (a user's own skills)
 * Workspace skills override built-ins with the same name.
 */
export interface Skill {
  name: string;
  description: string;
  body: string;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// src/skills/skill-loader.ts -> ../../prompts/skills
const BUILTIN_SKILLS_DIR = path.resolve(__dirname, "../../prompts/skills");

/** Parses a skill markdown file: `---\nname: ...\ndescription: ...\n---\n<body>`. */
function parseSkill(raw: string, fallbackName: string): Skill | null {
  const fm = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  const meta = fm ? fm[1] : "";
  const body = (fm ? fm[2] : raw).trim();
  const name =
    meta.match(/^\s*name:\s*(.+)$/m)?.[1].trim() || fallbackName;
  const description =
    meta.match(/^\s*description:\s*(.+)$/m)?.[1].trim() || "";
  if (!body) return null;
  return { name, description, body };
}

function readSkillsFromDir(dir: string): Skill[] {
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".md"));
  } catch {
    return []; // dir doesn't exist — fine
  }
  const skills: Skill[] = [];
  for (const file of files) {
    try {
      const raw = fs.readFileSync(path.join(dir, file), "utf-8");
      const skill = parseSkill(raw, file.replace(/\.md$/, ""));
      if (skill) skills.push(skill);
    } catch {
      // skip unreadable/malformed skill files
    }
  }
  return skills;
}

/**
 * Loads built-in skills plus the workspace's own skills. Workspace skills with
 * the same name take precedence (so a project can tailor a built-in recipe).
 */
export function loadSkills(workspacePath: string): Skill[] {
  const builtin = readSkillsFromDir(BUILTIN_SKILLS_DIR);
  const workspace = readSkillsFromDir(path.join(workspacePath, ".rei", "skills"));
  const byName = new Map<string, Skill>();
  for (const s of builtin) byName.set(s.name, s);
  for (const s of workspace) byName.set(s.name, s); // workspace overrides built-in
  return [...byName.values()];
}

/**
 * Builds the `use_skill` meta-tool. Its description embeds the catalog (one line
 * per skill) so the model knows what's available without loading any bodies.
 * Returns null when there are no skills (so the tool isn't exposed needlessly).
 */
export function buildUseSkillTool(skills: Skill[]): ToolDefinition | null {
  if (skills.length === 0) return null;
  const catalog = skills
    .map((s) => `- ${s.name}: ${s.description}`)
    .join("\n");
  return {
    type: "function",
    function: {
      name: "use_skill",
      description:
        "Load a reusable task recipe (a 'skill') for step-by-step guidance on a specific kind of " +
        "task. Call this BEFORE starting work that matches one of the skills below — it returns the " +
        "full recipe, which you should then follow.\n\nAvailable skills:\n" +
        catalog,
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "The exact skill name from the list above.",
          },
        },
        required: ["name"],
      },
    },
  };
}

/** Looks up a skill by name (case-insensitive, tolerant of minor mismatches). */
export function findSkill(skills: Skill[], name: string): Skill | undefined {
  const target = name.trim().toLowerCase();
  return (
    skills.find((s) => s.name.toLowerCase() === target) ??
    skills.find((s) => s.name.toLowerCase().includes(target) || target.includes(s.name.toLowerCase()))
  );
}
