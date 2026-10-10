import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { fromWireToolName } from "../contracts/mcp-tool-names.js";
import { realish, within } from "../agent-mode/tools-loop/read-scope.js";

/**
 * Personas — who REI is, per surface. See docs/persona-spec.md.
 *
 * A persona REPLACES REI's coding identity (a role is layered on it). This module only reads and
 * validates the files; the prompt, the agent and the surfaces come in later phases.
 *
 * Strict where roles are lenient: a role with a typo falls back to defaults, which is harmless in a
 * coding session. A persona answers strangers on a public number — a malformed one must fail at
 * load with a reason, and each surface decides its fallback (see the spec's activation table).
 */

export interface Persona {
  name: string;
  description: string;
  /** Tool names and patterns (`mcp:*`, `mcp:<server>/*`) it may use; undefined = the surface's set. */
  tools?: string[];
  /** Absolute directory it may read; undefined = the workspace. Never under `.rei/`. */
  knowledgeDir?: string;
  preferredModel?: string;
  /** `auto` (the user's language) or a language code. */
  language: string;
  maxReplyChars?: number;
  handoff: string;
  /** Identity, tone, scope — replaces REI's identity in the system prompt. */
  body: string;
  source: "workspace" | "builtin";
}

export type PersonaResult = { ok: true; persona: Persona } | { ok: false; error: string };

export interface PersonaListing {
  name: string;
  description?: string;
  source: "workspace" | "builtin";
  /** Set when the file does not load — listed anyway, so a broken persona is visible, not missing. */
  error?: string;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// src/personas/persona-loader.ts → ../../prompts/personas
const BUILTIN_DIR = path.resolve(__dirname, "../../prompts/personas");
const workspaceDir = (ws: string) => path.join(ws, ".rei", "personas");

const DEFAULT_HANDOFF = "I can't help with that here.";
// A name becomes a file path; nothing that could leave the personas directory gets that far.
const VALID_NAME = /^[a-z0-9][a-z0-9_-]*$/i;
const LANGUAGE_CODE = /^[a-z]{2,3}(-[A-Za-z]{2})?$/;

interface Options {
  /** Where the shipped personas live. Overridable for tests only. */
  builtinDir?: string;
}

export function loadPersona(name: string, workspacePath: string, opts: Options = {}): PersonaResult {
  const wanted = name.trim().toLowerCase();
  if (!VALID_NAME.test(wanted)) {
    return { ok: false, error: `Invalid persona name "${name}": letters, digits, - and _ only.` };
  }
  const builtinDir = opts.builtinDir ?? BUILTIN_DIR;
  const candidates: Array<[string, Persona["source"]]> = [
    [path.join(workspaceDir(workspacePath), `${wanted}.md`), "workspace"],
    [path.join(builtinDir, `${wanted}.md`), "builtin"],
  ];
  for (const [file, source] of candidates) {
    if (!fs.existsSync(file)) continue;
    return parsePersona(fs.readFileSync(file, "utf8"), wanted, source, workspacePath, file);
  }
  return {
    ok: false,
    error: `Persona "${wanted}" not found — looked in ${path.join(".rei", "personas")}/ and the built-in personas.`,
  };
}

/** Every persona, sorted by name; the workspace's file wins over a shipped one of the same name. */
export function listPersonas(workspacePath: string, opts: Options = {}): PersonaListing[] {
  const names = new Set<string>();
  for (const dir of [workspaceDir(workspacePath), opts.builtinDir ?? BUILTIN_DIR]) {
    try {
      for (const f of fs.readdirSync(dir)) if (f.endsWith(".md")) names.add(f.slice(0, -3).toLowerCase());
    } catch {
      // a missing directory is just an empty one
    }
  }
  return [...names].sort().map((name) => {
    const r = loadPersona(name, workspacePath, opts);
    if (r.ok) return { name, description: r.persona.description, source: r.persona.source };
    const inWorkspace = fs.existsSync(path.join(workspaceDir(workspacePath), `${name}.md`));
    return { name, source: inWorkspace ? "workspace" : "builtin", error: r.error };
  });
}

function parsePersona(
  raw: string,
  fileName: string,
  source: Persona["source"],
  workspacePath: string,
  file: string,
): PersonaResult {
  const fail = (why: string): PersonaResult => ({ ok: false, error: `Persona "${fileName}" (${file}): ${why}` });
  const fm = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!fm) return fail("missing the --- frontmatter --- block.");
  const meta = fm[1];
  const body = fm[2].trim();
  const field = (k: string) => {
    const v = meta.match(new RegExp(`^\\s*${k}:\\s*(.+)$`, "m"))?.[1].trim();
    return v?.replace(/^["']|["']$/g, "");
  };

  const name = field("name");
  if (!name) return fail("`name` is required.");
  if (name.toLowerCase() !== fileName) {
    return fail(`\`name: ${name}\` does not match the file name "${fileName}" — they must be the same.`);
  }
  const description = field("description");
  if (!description) return fail("`description` is required.");
  if (!body) return fail("the body (who the assistant is) is empty.");

  let tools: string[] | undefined;
  const toolsRaw = meta.match(/^\s*tools:\s*(.+)$/m)?.[1].trim();
  if (toolsRaw !== undefined) {
    const list = toolsRaw.match(/^\[(.*)\]$/);
    if (!list) return fail("`tools` must be a list, e.g. [read_files, grep_code, \"mcp:*\"].");
    tools = list[1]
      .split(",")
      .map((t) => t.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean);
  }

  let knowledgeDir: string | undefined;
  const kd = field("knowledgeDir");
  if (kd) {
    const resolved = path.resolve(workspacePath, kd);
    const real = realish(resolved);
    if (!within(real, realish(workspacePath))) {
      return fail(`\`knowledgeDir: ${kd}\` is outside the workspace.`);
    }
    if (within(real, realish(path.join(workspacePath, ".rei")))) {
      return fail(`\`knowledgeDir: ${kd}\` is inside .rei/, which holds every conversation — never readable.`);
    }
    knowledgeDir = resolved;
  }

  const language = field("language") ?? "auto";
  if (language !== "auto" && !LANGUAGE_CODE.test(language)) {
    return fail(`\`language: ${language}\` must be "auto" or a language code (es, en, pt-BR…).`);
  }

  let maxReplyChars: number | undefined;
  const mrc = field("maxReplyChars");
  if (mrc !== undefined) {
    if (!/^\d+$/.test(mrc) || Number(mrc) <= 0) return fail(`\`maxReplyChars: ${mrc}\` must be a positive integer.`);
    maxReplyChars = Number(mrc);
  }

  return {
    ok: true,
    persona: {
      name: fileName,
      description,
      tools,
      knowledgeDir,
      preferredModel: field("preferredModel"),
      language,
      maxReplyChars,
      handoff: field("handoff") ?? DEFAULT_HANDOFF,
      body,
      source,
    },
  };
}

/**
 * The tools a persona actually gets on a surface: what it lists ∩ what the surface offers. It can
 * only narrow — a tool the surface does not offer is never added, it is reported in `dropped`
 * (with any pattern that matched nothing) so the caller can log it.
 */
export function resolvePersonaTools(
  persona: Pick<Persona, "tools">,
  offered: readonly string[],
): { tools: string[]; dropped: string[] } {
  if (!persona.tools) return { tools: [...offered], dropped: [] };
  const patterns = persona.tools;
  // Providers may present MCP tools as mcp:server__tool; patterns are written as mcp:server/…
  const matches = (pattern: string, name: string) => {
    const canonical = fromWireToolName(name);
    if (pattern === "mcp:*") return canonical.startsWith("mcp:");
    if (pattern.startsWith("mcp:") && pattern.endsWith("/*")) return canonical.startsWith(pattern.slice(0, -1));
    return canonical === pattern || name === pattern;
  };
  return {
    tools: offered.filter((name) => patterns.some((p) => matches(p, name))),
    dropped: patterns.filter((p) => !offered.some((name) => matches(p, name))),
  };
}
