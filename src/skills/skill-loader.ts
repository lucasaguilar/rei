import * as fs from "fs";
import * as os from "os";
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
 * Skills come from three places, each overriding the one before by name:
 *   1. Built-in:        <rei>/prompts/skills/
 *   2. User-global:     $XDG_CONFIG_HOME/rei/skills/   (default ~/.config/rei/skills/)
 *   3. Per-workspace:   {workspace}/.rei/skills/
 * Each directory accepts flat `<name>.md` files and the `<name>/SKILL.md` layout that Claude Code
 * and installers like gentle-ai write, so skills from that ecosystem load unchanged.
 */
export interface Skill {
  name: string;
  description: string;
  /**
   * Which agent modes this skill is offered in. Defaults to `["agent"]` when the
   * frontmatter omits `modes:` — most skills are execution recipes. Planning-only
   * process skills (e.g. micro-task decomposition) declare `modes: [planning]`.
   */
  modes: SkillMode[];
  body: string;
}

export type SkillMode = "agent" | "planning" | "ask";

const DEFAULT_SKILL_MODES: SkillMode[] = ["agent"];
const VALID_SKILL_MODES: SkillMode[] = ["agent", "planning", "ask"];

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// src/skills/skill-loader.ts -> ../../prompts/skills
const BUILTIN_SKILLS_DIR = path.resolve(__dirname, "../../prompts/skills");

/** Parses a skill markdown file: `---\nname: ...\ndescription: ...\n---\n<body>`. */
function parseSkill(raw: string, fallbackName: string): Skill | null {
  const fm = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  const meta = fm ? fm[1] : "";
  const body = (fm ? fm[2] : raw).trim();
  const name = readScalar(meta, "name") || fallbackName;
  const description = readScalar(meta, "description");
  if (!body) return null;
  return { name, description, modes: parseModes(meta), body };
}

/**
 * Reads one top-level frontmatter string. Not a YAML parser — just the two shapes that ecosystem
 * skills actually use beyond a bare value: a quoted string (`description: "Trigger: ..."`, where a
 * colon forces the quotes) and a block scalar (`description: >` + indented lines). Without this the
 * quotes leaked into the use_skill catalog and a block scalar left the description as a lone `>`.
 */
function readScalar(meta: string, key: string): string {
  const lines = meta.split("\n");
  const idx = lines.findIndex((l) => new RegExp(`^${key}:`).test(l));
  if (idx === -1) return "";
  const value = lines[idx].slice(key.length + 1).trim();
  if (/^[>|][+-]?$/.test(value)) {
    const block: string[] = [];
    for (const line of lines.slice(idx + 1)) {
      if (line.trim() && !/^\s/.test(line)) break; // next top-level key
      block.push(line.trim());
    }
    return block.filter(Boolean).join(value.startsWith(">") ? " " : "\n");
  }
  const quoted = value.match(/^(["'])(.*)\1$/);
  return quoted ? quoted[2] : value;
}

/**
 * Parses the optional `modes:` frontmatter field. Accepts a bracketed list
 * (`modes: [planning, agent]`), a bare comma list (`modes: planning, agent`),
 * or a single value (`modes: planning`). Unknown tokens are dropped; if nothing
 * valid remains the skill falls back to `DEFAULT_SKILL_MODES` (`["agent"]`).
 */
function parseModes(meta: string): SkillMode[] {
  const raw = meta.match(/^\s*modes:\s*(.+)$/m)?.[1].trim();
  if (!raw) return [...DEFAULT_SKILL_MODES];
  const tokens = raw
    .replace(/^\[|\]$/g, "")
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean) as SkillMode[];
  const valid = tokens.filter((t) => VALID_SKILL_MODES.includes(t));
  return valid.length > 0 ? [...new Set(valid)] : [...DEFAULT_SKILL_MODES];
}

function readSkillsFromDir(dir: string): Skill[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return []; // dir doesn't exist — fine
  }
  const skills: Skill[] = [];
  for (const name of names) {
    // statSync, not Dirent: a Dirent reports a symlink as neither file nor directory, which
    // silently dropped linked skills — and linking a skill from its own repo is the common case.
    let stat: fs.Stats;
    try {
      stat = fs.statSync(path.join(dir, name));
    } catch {
      continue; // dangling link
    }
    // `<name>.md`, or `<name>/SKILL.md` — there the directory, not "SKILL", is the fallback name.
    const [file, fallbackName] = stat.isFile() && name.endsWith(".md")
      ? [path.join(dir, name), name.replace(/\.md$/, "")]
      : stat.isDirectory()
        ? [path.join(dir, name, "SKILL.md"), name]
        : [null, ""];
    if (!file) continue;
    try {
      const skill = parseSkill(fs.readFileSync(file, "utf-8"), fallbackName);
      if (skill) skills.push(skill);
    } catch {
      // skip missing/unreadable/malformed skill files
    }
  }
  return skills;
}

/**
 * The user's own skills, shared across workspaces. Deliberately NOT under ~/.rei: that is REI's
 * install directory, and the local installer's `rsync --delete` would wipe anything a user put there.
 */
function globalSkillsDir(): string {
  const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(configHome, "rei", "skills");
}

/**
 * Loads built-in, user-global and workspace skills. Later sources win by name, so a user can
 * tailor a built-in recipe everywhere and a project can tailor it again for itself.
 */
export function loadSkills(workspacePath: string): Skill[] {
  const byName = new Map<string, Skill>();
  for (const dir of [BUILTIN_SKILLS_DIR, globalSkillsDir(), path.join(workspacePath, ".rei", "skills")]) {
    for (const s of readSkillsFromDir(dir)) byName.set(s.name, s);
  }
  return [...byName.values()];
}

/** Filters skills to those offered in the given agent mode. */
export function skillsForMode(skills: Skill[], mode: SkillMode): Skill[] {
  return skills.filter((s) => s.modes.includes(mode));
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
  if (!target) return undefined; // empty name must not fuzzy-match the first skill
  return (
    skills.find((s) => s.name.toLowerCase() === target) ??
    skills.find((s) => s.name.toLowerCase().includes(target) || target.includes(s.name.toLowerCase()))
  );
}
