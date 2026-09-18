import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CommandHandler, CommandResult } from "./command-handler.js";
import { resolveDefaultSessionMode, type ChatSession } from "../types.js";
import {
  archiveCurrentSession,
  currentPath,
  listSessions,
  getActiveSessionId,
  loadSessionById,
  saveSession,
} from "../session-store.js";
import { bindToSession, claimSessionName } from "../session-lock.js";
import { estimateTokens } from "../helpers/token-estimator.js";
import {
  clearCurrentPlan,
  restoreCurrentPlanFromSession,
} from "../plan-tracker.js";

/**
 * Recursively counts files and collects top-level folders, excluding hidden dirs
 * and common ignored directories (node_modules, .git, dist).
 */
function getRepoSummary(workspacePath: string): { fileCount: number; topFolders: string[] } {
  const ignored = new Set(['node_modules', '.git', 'dist']);
  let fileCount = 0;
  const topFolders: string[] = [];

  function walk(dir: string, depth: number): void {
    try {
      for (const entry of fs.readdirSync(dir)) {
        const fullPath = path.join(dir, entry);
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
          if (depth === 0 && !entry.startsWith('.') && !ignored.has(entry)) {
            topFolders.push(entry);
          }
          if (!entry.startsWith('.') && !ignored.has(entry)) {
            walk(fullPath, depth + 1);
          }
        } else if (stat.isFile()) {
          fileCount++;
        }
      }
    } catch {
      // Permission denied or missing dir — skip
    }
  }

  walk(workspacePath, 0);
  topFolders.sort();
  return { fileCount, topFolders };
}

/**
 * Session lifecycle: `/session` — info · save-as · new · archive · list · load.
 * `/compact` lives in compact-command.ts: it edits the history, it does not move the session.
 */
export const sessionCommands: CommandHandler = {
  match: (c) =>
    c === "/session" ||
    c === "/session info" ||
    c === "/session list" ||
    /^\/session\s+save(?:-as)?(?:\s+.+)?$/.test(c) ||
    /^\/session\s+new(?:\s+.+)?$/.test(c) ||
    /^\/session\s+archive(?:\s+.+)?$/.test(c) ||
    /^\/session\s+load\s+\S+$/.test(c),

  run: async ({ command: trimmed, session, workspacePath, provider }): Promise<CommandResult> => {

    if (trimmed === "/session") {
      const nonSystem = session.messages.filter((m) => m.role !== "system");
      const turns = Math.floor(nonSystem.length / 2);
      const created = session.createdAt
        ? new Date(session.createdAt).toLocaleString()
        : "not saved yet";

      return {
        success: true,
        response:
          `[REI] Current session\n` +
          `Mode: ${session.mode}\n` +
          `Turns: ${turns}\n` +
          `Created: ${created}\n` +
          `Summary: ${session.summary ? "yes" : "no"}`,
      };
    }

    if (trimmed === "/session info") {
      const filePath = currentPath(workspacePath);
      const sessionId = path.basename(filePath, ".json");
      const fileLabel = fs.existsSync(filePath) ? filePath : "not saved yet";

      const userMsgs = session.messages.filter((m) => m.role === "user");
      const assistantMsgs = session.messages.filter((m) => m.role === "assistant");
      const toolResults = session.messages.filter((m) => m.role === "tool");
      const toolCalls = session.messages
        .filter((m) => m.tool_calls && m.tool_calls.length > 0)
        .reduce((sum, m) => sum + m.tool_calls!.length, 0);

      const userTokens = userMsgs.reduce((a, m) => a + estimateTokens(m.content), 0);
      const assistantTokens = assistantMsgs.reduce((a, m) => a + estimateTokens(m.content), 0);
      const totalTokens = userTokens + assistantTokens;

      const repoSummary = getRepoSummary(workspacePath);

      return {
        success: true,
        response:
          `[REI] Session Info\n` +
          `\n` +
          `File: ${fileLabel}\n` +
          `ID: ${sessionId}\n` +
          `\n` +
          `Messages\n` +
          `  Total: ${session.messages.length}\n` +
          `  User: ${userMsgs.length}\n` +
          `  Assistant: ${assistantMsgs.length}\n` +
          `  Tools: ${toolCalls} calls, ${toolResults.length} results\n` +
          `\n` +
          `Tokens\n` +
          `  Input: ${userTokens.toLocaleString()}\n` +
          `  Output: ${assistantTokens.toLocaleString()}\n` +
          `  Total: ${totalTokens.toLocaleString()}\n` +
          `\n` +
          `Workspace: ${workspacePath}\n` +
          `\n` +
          `Repository summary:\n` +
          `  Total files scanned: ${repoSummary.fileCount}\n` +
          `  Top-level folders: ${repoSummary.topFolders.join(", ")}`,
        recordInSession: false,
      };
    }

    // `/session save-as <name>` — name the session you are IN, and stay in it. `/session archive`
    // names one on the way out; this is the other half, and the difference is the whole point.
    const saveAsMatch = trimmed.match(/^\/session\s+save(?:-as)?(?:\s+(.+))?$/);
    if (saveAsMatch) {
      const requested = saveAsMatch[1]?.trim();
      if (!requested) {
        return {
          success: false,
          recordInSession: false,
          response:
            `[REI] Usage: /session save-as <name>\n` +
            `Every turn is already saved automatically — this gives the session a NAME you can ` +
            `come back to with \`rei -s <name>\`, without interrupting it.`,
        };
      }

      const result = claimSessionName(workspacePath, requested);
      if (!result.ok) {
        const why =
          result.reason === "exists"
            ? `A session named '${requested}' already exists. Pick another name, or open that one with /session load ${requested}.`
            : result.reason === "locked"
              ? `A session named '${requested}' is open in another terminal (PID ${result.holderPid}, since ${result.startedAt}).`
              : result.reason === "reserved"
                ? `'${requested}' is reserved for REI's default session file.`
                : `'${requested}' leaves nothing usable as a file name (letters and digits only).`;
        return { success: false, recordInSession: false, response: `[REI] ${why}` };
      }

      // Re-saved immediately so the named file is on disk even if this session never takes another
      // turn — the point of naming it is being able to come back to it.
      saveSession(
        workspacePath,
        session.messages,
        session.mode,
        session.summary,
        session.createdAt,
      );

      return {
        success: true,
        recordInSession: false,
        response:
          result.id === result.previousId
            ? `[REI] This session is already named '${result.id}'.`
            : `[REI] Session saved as '${result.id}' and still running — nothing was interrupted.\n` +
              `Reopen it later with \`rei -s ${result.id}\`.`,
      };
    }

    const sessionNewMatch = trimmed.match(/^\/session\s+new(?:\s+(.+))?$/);
    if (sessionNewMatch) {
      const customName = sessionNewMatch[1]?.trim();
      const archivedName =
        session.messages.length > 0 ? archiveCurrentSession(workspacePath, customName) : null;
      // A new session starts in the default mode (agent), overridable via REI_DEFAULT_MODE.
      const newSession: ChatSession = {
        messages: [],
        mode: resolveDefaultSessionMode(),
      };

      saveSession(workspacePath, newSession.messages, newSession.mode);
      clearCurrentPlan(workspacePath);

      return {
        success: true,
        response: archivedName
          ? `[REI] Archived current session as ${archivedName}. Started a new ${newSession.mode} session.`
          : `[REI] Started a new ${newSession.mode} session.`,
        newSession,
        recordInSession: false,
      };
    }

    const sessionArchiveMatch = trimmed.match(/^\/session\s+archive(?:\s+(.+))?$/);
    if (sessionArchiveMatch) {
      const customName = sessionArchiveMatch[1]?.trim();
      if (session.messages.length === 0) {
        return {
          success: false,
          response: "[REI] Current session is empty. Nothing to archive.",
        };
      }
      const archivedName = archiveCurrentSession(workspacePath, customName);
      // A new session starts in the default mode (agent), overridable via REI_DEFAULT_MODE.
      const newSession: ChatSession = {
        messages: [],
        mode: resolveDefaultSessionMode(),
      };
      saveSession(workspacePath, newSession.messages, newSession.mode);
      clearCurrentPlan(workspacePath);

      return {
        success: true,
        response: archivedName
          ? `[REI] Archived current session as ${archivedName}. Started a new ${newSession.mode} session.`
          : `[REI] Failed to archive session.`,
        newSession,
        recordInSession: false,
      };
    }

    if (trimmed === "/session list") {
      const sessions = listSessions(workspacePath);
      if (sessions.length === 0) {
        return { success: true, response: "[REI] No archived sessions found." };
      }

      const lines = sessions.slice(0, 20).map((entry) => {
        const updated = new Date(entry.updatedAt).toLocaleString();
        return `- ${entry.id} | ${entry.mode} | ${entry.turns} turns | updated ${updated}`;
      });

      return {
        success: true,
        response: `[REI] Archived sessions:\n${lines.join("\n")}`,
      };
    }

    const loadSessionMatch = trimmed.match(/^\/session\s+load\s+(\S+)$/);
    if (loadSessionMatch) {
      const id = loadSessionMatch[1];
      const loaded = loadSessionById(workspacePath, id);

      if (!loaded) {
        return { success: false, response: `[REI] Session not found: ${id}` };
      }

      // The session being left keeps its OWN file — every instance has had one since multi-session,
      // so there is nothing to rescue. Only the legacy shared `current.json` still needs archiving,
      // because the load below would otherwise overwrite it.
      const leaving = getActiveSessionId();
      const archivedName =
        session.messages.length > 0 && leaving === "current"
          ? archiveCurrentSession(workspacePath)
          : null;

      // Bind to the loaded session, so what you do NEXT is written back into it. Without this the
      // load was one-way: you continued in your own file and the session you opened stayed frozen
      // at the state you found it in — the work silently went somewhere else.
      const bound = bindToSession(workspacePath, id);
      if (!bound.ok) {
        return {
          success: false,
          recordInSession: false,
          response:
            `[REI] Session '${id}' is open in another terminal (PID ${bound.holderPid}, since ` +
            `${bound.startedAt}). It was not loaded — two instances writing one history lose turns.`,
        };
      }

      saveSession(
        workspacePath,
        loaded.messages,
        loaded.mode,
        loaded.summary,
        loaded.createdAt,
      );
      restoreCurrentPlanFromSession(workspacePath, loaded.messages);

      return {
        success: true,
        response: archivedName
          ? `[REI] Archived current session as ${archivedName}. Loaded session ${id} — it is now the active one, and further turns are saved into it.`
          : `[REI] Loaded session ${id} — it is now the active one, and further turns are saved into it.\n` +
            `The session you were in stays on disk as '${leaving}'.`,
        newSession: {
          messages: loaded.messages,
          mode: loaded.mode,
          createdAt: loaded.createdAt,
          summary: loaded.summary,
        },
      };
    }

    // Unreachable: match() guarantees one of the branches above handled it.
    return { success: false, response: "[REI] Unknown /session command." };
  },
};
