import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import type { SessionMode } from "../chat/types.js";

/**
 * A "role" is a data-driven posture (an adversarial auditor, a security reviewer, …) written in
 * Markdown — NOT a hardcoded 4th mode. Its body becomes a high-priority system-prompt prefix; its
 * frontmatter says which permission profile it borrows (`baseMode`) and which model it prefers.
 * Adding a role = dropping a `.md` in prompts/roles/ (built-in) or {workspace}/.rei/roles/ (custom).
 * See docs/roles-spec.md.
 */
export interface Role {
  name: string;
  description: string;
  /** Permission profile the role borrows (default "planning" → read-only). */
  baseMode: SessionMode;
  /** Optional: files the role may write (e.g. "*.review.md"). Enforced in Phase 2. */
  writeGlob?: string;
  /** Optional: a preferred model id (a DIFFERENT model than the builder — Phase 2). */
  preferredModel?: string;
  /** The posture / system-prompt body injected when the role is active. */
  body: string;
}

const VALID_MODES: SessionMode[] = ["ask", "planning", "agent"];

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// src/skills/role-loader.ts -> ../../prompts/roles
const BUILTIN_ROLES_DIR = path.resolve(__dirname, "../../prompts/roles");
const workspaceRolesDir = (ws: string) => path.join(ws, ".rei", "roles");

/** Parses a role markdown file: `---\n<frontmatter>\n---\n<body>`. */
function parseRole(raw: string, fallbackName: string): Role | null {
  const fm = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  const meta = fm ? fm[1] : "";
  const body = (fm ? fm[2] : raw).trim();
  if (!body) return null;
  const field = (k: string) =>
    meta.match(new RegExp(`^\\s*${k}:\\s*(.+)$`, "m"))?.[1].trim();
  const stripQuotes = (s?: string) => s?.replace(/^["']|["']$/g, "");

  const baseModeRaw = (field("baseMode") ?? "planning").toLowerCase();
  const baseMode = VALID_MODES.includes(baseModeRaw as SessionMode)
    ? (baseModeRaw as SessionMode)
    : "planning";

  return {
    name: field("name") || fallbackName,
    description: field("description") || "",
    baseMode,
    writeGlob: stripQuotes(field("writeGlob")),
    preferredModel: stripQuotes(field("preferredModel")),
    body,
  };
}

function readRolesFromDir(dir: string): Role[] {
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".md"));
  } catch {
    return [];
  }
  const roles: Role[] = [];
  for (const file of files) {
    try {
      const raw = fs.readFileSync(path.join(dir, file), "utf-8");
      const role = parseRole(raw, file.replace(/\.md$/, ""));
      if (role) roles.push(role);
    } catch {
      // skip unreadable/malformed role files
    }
  }
  return roles;
}

/** All available roles (workspace roles override built-ins with the same name). */
export function listRoles(workspacePath: string): Role[] {
  const builtins = readRolesFromDir(BUILTIN_ROLES_DIR);
  const custom = readRolesFromDir(workspaceRolesDir(workspacePath));
  const byName = new Map<string, Role>();
  for (const r of builtins) byName.set(r.name, r);
  for (const r of custom) byName.set(r.name, r); // workspace wins
  return [...byName.values()];
}

/** Loads a role by name (case-insensitive), or null if none matches. */
export function loadRole(name: string, workspacePath: string): Role | null {
  const target = name.trim().toLowerCase();
  return listRoles(workspacePath).find((r) => r.name.toLowerCase() === target) ?? null;
}
