import * as fs from "fs";
import { paint } from "../theme/palette.js";
import * as path from "path";
import { scanWorkspace } from "../../workspace/workspace-scanner.js";
import { MentionEntry, CommandEntry } from "../models/chat.types.js";
import { listRoles } from "../../skills/role-loader.js";
import { RESERVED_COMMAND_NAMES } from "../../chat/commands/role-agent-commands.js";
import { activeManualModel } from "../../chat/manual-model.js";
import type { SessionMode } from "../../chat/types.js";

export function toPosixPath(input: string): string {
  // NOTE: Replace all Windows-style backslashes with POSIX forward slashes
  return input.replace(/\\/g, "/");
}

// User-authored artifacts under .rei/ that the workspace scanner deliberately ignores (it skips all
// dot-dirs so REI's logs/sessions never pollute the RAG/repo-map). Plans, specs and their reviews DO
// belong in the @ picker so a role/turn can reference them (e.g. `@.rei/plans/x.md`). Reviews live
// next to their plan (.rei/plans/<name>.review.md), so listing .rei/plans covers them too.
const REI_ARTIFACT_DIRS = [".rei/plans", ".rei/specs"];

function scanReiArtifacts(workspacePath: string): string[] {
  const out: string[] = [];
  for (const rel of REI_ARTIFACT_DIRS) {
    try {
      for (const f of fs.readdirSync(path.join(workspacePath, rel))) {
        if (f.endsWith(".md")) out.push(`${rel}/${f}`);
      }
    } catch {
      // dir doesn't exist yet — fine
    }
  }
  return out;
}

/**
 * The roles on disk, as command-palette entries — so `/aud` + Tab completes to `/auditor `.
 *
 * TWO entries per role, because a role has two invocations and both are typed. `/auditor <task>`
 * runs it isolated; `/role auditor` wears it here. Completing only the first left `/role git-` with
 * nothing to offer — the palette matches whole commands by prefix, and `/role <name>` is not a
 * static command.
 *
 * `/auditor` is a command only because a file in .rei/roles/ says so, which means it appears in no
 * static list: without this it is invocable but undiscoverable, and a feature nobody can find is
 * one that does not exist.
 *
 * A role whose name collides with a built-in is left OUT rather than listed: the static command
 * wins dispatch, so offering it would complete to something that does something else. `/roles`
 * reports the collision, which is where the fix (rename the role) belongs.
 */
/**
 * Everything the palette reads off disk. Both halves are files that can appear mid-session — the
 * turn writes an OCR output, you (or the agent) write a role — so they are rescanned together
 * after every turn, and pairing them here keeps the two from drifting apart.
 */
/**
 * The session facts the sticky block shows: the active document, the active role, and whether a
 * manual `/model` is outranking that role's own. They are read together on every draw and must be
 * synced together — three separate assignments is three chances for one to be forgotten.
 */
export function sessionIndicators(session: {
  activeDocument?: string;
  activeRole?: string;
  manualModel?: string;
  manualModelScope?: "agent" | "base";
  mode?: SessionMode;
}): { activeDocument?: string; activeRole?: string; manualModel?: string } {
  return {
    activeDocument: session.activeDocument,
    activeRole: session.activeRole,
    // Scoped, like the turn: a choice made for the agent slot must not light up "model overridden"
    // while you are in ask — the badge would name a model the turn is not going to use.
    manualModel: activeManualModel(session, session.mode ?? "ask"),
  };
}

export function buildPaletteSources(workspacePath: string): {
  mentionEntries: MentionEntry[];
  roleEntries: CommandEntry[];
} {
  return {
    mentionEntries: buildMentionEntries(workspacePath),
    roleEntries: buildRoleCommandEntries(workspacePath),
  };
}

export function buildRoleCommandEntries(workspacePath: string): CommandEntry[] {
  try {
    return listRoles(workspacePath)
      .filter((r) => !RESERVED_COMMAND_NAMES.has(r.name.toLowerCase()))
      .flatMap((r) => [
        {
          // The `<task>` suffix follows the COMMANDS convention: it documents the usage in the
          // palette, and commandInsertText strips it and leaves the cursor after a space.
          command: `/${r.name} <task>`,
          description: `role · ${r.description}`,
          requiresArgs: true,
        },
        {
          // No placeholder: `/role auditor` is complete as typed, so Tab inserts it ready to send.
          command: `/role ${r.name}`,
          description: `role · wear ${r.name} in this session`,
        },
      ]);
  } catch {
    return []; // an unreadable roles dir must never take the palette down
  }
}

export function buildMentionEntries(workspacePath: string): MentionEntry[] {
  const scanned = scanWorkspace(workspacePath).map((f) => toPosixPath(f.path));
  const allPaths = [...scanned, ...scanReiArtifacts(workspacePath)];
  const fileSet = new Set<string>();
  const dirSet = new Set<string>();

  for (const filePath of allPaths) {
    fileSet.add(filePath);

    let currentDir = path.posix.dirname(filePath);
    while (currentDir && currentDir !== ".") {
      dirSet.add(`${currentDir}/`);
      const parent = path.posix.dirname(currentDir);
      if (parent === currentDir) break;
      currentDir = parent;
    }
  }

  const dirs = Array.from(dirSet)
    .sort((a, b) => a.localeCompare(b))
    .map((value) => ({ value, description: "folder", isDir: true }));

  const regularFiles = Array.from(fileSet)
    .sort((a, b) => a.localeCompare(b))
    .map((value) => ({ value, description: "file", isDir: false }));

  return [...dirs, ...regularFiles];
}

export function displayUserLabel(displayLabel: string): string {
  return paint("user", `You: ${displayLabel}`);
}
