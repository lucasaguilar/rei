import type { CommandHandler, CommandResult } from "./command-handler.js";
import type { ChatSession } from "../types.js";
import {
  archiveCurrentSession,
  listSessions,
  loadSessionById,
  saveSession,
} from "../session-store.js";
import {
  clearCurrentPlan,
  restoreCurrentPlanFromSession,
} from "../plan-tracker.js";

/**
 * `/session` group: show info · new · archive · list · load.
 * Extracted verbatim from menu-command-processor (Phase 1 of the refactor — no behavior change).
 */
export const sessionCommands: CommandHandler = {
  match: (c) =>
    c === "/session" ||
    c === "/session list" ||
    /^\/session\s+new(?:\s+.+)?$/.test(c) ||
    /^\/session\s+archive(?:\s+.+)?$/.test(c) ||
    /^\/session\s+load\s+\S+$/.test(c),

  run: ({ command: trimmed, session, workspacePath }): CommandResult => {
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

    const sessionNewMatch = trimmed.match(/^\/session\s+new(?:\s+(.+))?$/);
    if (sessionNewMatch) {
      const customName = sessionNewMatch[1]?.trim();
      const archivedName =
        session.messages.length > 0 ? archiveCurrentSession(workspacePath, customName) : null;
      const newSession: ChatSession = { messages: [], mode: session.mode };

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
      const newSession: ChatSession = { messages: [], mode: session.mode };
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

      const currentHadContent = session.messages.length > 0;
      const archivedName = currentHadContent ? archiveCurrentSession(workspacePath) : null;

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
          ? `[REI] Archived current session as ${archivedName}. Loaded session ${id}.`
          : `[REI] Loaded session ${id}.`,
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
