import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CommandHandler, CommandResult } from "./command-handler.js";
import { resolveDefaultSessionMode, type ChatSession } from "../types.js";
import {
  archiveCurrentSession,
  currentPath,
  listSessions,
  loadSessionById,
  saveSession,
} from "../session-store.js";
import { estimateTokens } from "../helpers/token-estimator.js";
import {
  clearCurrentPlan,
  restoreCurrentPlanFromSession,
} from "../plan-tracker.js";
import { resolveSessionModel } from "../manual-model.js";
import { compactorModelFor, compactSession } from "../compactor.js";

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
 * Session lifecycle: `/session` (info · new · archive · list · load) and `/compact`.
 * Extracted verbatim from menu-command-processor (Phase 1 of the refactor — no behavior change).
 */
export const sessionCommands: CommandHandler = {
  match: (c) =>
    c === "/session" ||
    c === "/session info" ||
    c === "/session list" ||
    c === "/compact" ||
    /^\/session\s+new(?:\s+.+)?$/.test(c) ||
    /^\/session\s+archive(?:\s+.+)?$/.test(c) ||
    /^\/session\s+load\s+\S+$/.test(c),

  run: async ({ command: trimmed, session, workspacePath, provider }): Promise<CommandResult> => {
    if (trimmed === "/compact") {
      const nonSystem = session.messages.filter((m) => m.role !== "system");
      if (nonSystem.length < 2) {
        return {
          success: false,
          response: "[REI] Session is too short to compact (nothing to summarize).",
        };
      }

      // No override → summarize with the model this session is ALREADY running on. Falling back to
      // the provider's default meant `<PREFIX>_MODEL` (the ask/planning one), so on a local backend
      // /compact could load a SECOND model just to write a summary.
      const compactorModel = compactorModelFor(
        resolveSessionModel(session, workspacePath),
      );

      // Warn if the model name looks like OpenRouter format but the provider is Ollama.
      const providerName = (process.env.MODEL_PROVIDER ?? "").toLowerCase();
      const modelWarning =
        compactorModel && providerName === "ollama" && compactorModel.includes("/")
          ? `\n⚠️  COMPACTOR_MODEL="${compactorModel}" looks like OpenRouter format. ` +
            `For Ollama use the local name (e.g. qwen3:4b). ` +
            `Run \`ollama pull qwen3:4b\` and set COMPACTOR_MODEL=qwen3:4b.`
          : "";

      try {
        const beforeCount = nonSystem.length;
        const { messages: compactedMessages, skipped, model: summarizedBy } = await compactSession({
          messages: session.messages,
          provider,
          modelOverride: compactorModel,
          force: true, // manual /compact always bypasses the auto-threshold
        });
        const afterCount = compactedMessages.filter((m) => m.role !== "system").length;

        // Compaction fails softly so a bad summary never kills a turn — which means SUCCESS here is
        // not "no exception", it is "the history actually shrank". Reporting the former printed
        // "Session compacted (model: qwen/qwen3-4b). 117 → 117 messages" over a 404, and the count
        // that proved it was right there in the message.
        if (skipped) {
          return {
            success: false,
            recordInSession: false,
            response:
              `[REI] Nothing was compacted — the full history is intact (${beforeCount} messages).\n` +
              `  Reason: ${skipped}` +
              (compactorModel
                ? `\n  COMPACTOR_MODEL is set to '${compactorModel}'. Clear it to summarize with the ` +
                  `model already loaded — no second model to load, and no timeout on the call.`
                : ""),
          };
        }

        saveSession(
          workspacePath,
          compactedMessages,
          session.mode,
          session.summary,
          session.createdAt,
        );

        // The model that WROTE it, not the one we asked for: a failed COMPACTOR_MODEL falls back to
        // the provider's, and crediting the summary to a model that 404'd is how this command came
        // to report `Session compacted (model: qwen/qwen3-4b)` over a failure.
        const modelLabel = summarizedBy ? ` (model: ${summarizedBy})` : "";
        const fellBack =
          compactorModel && summarizedBy && summarizedBy !== compactorModel
            ? `\n⚠️  COMPACTOR_MODEL='${compactorModel}' failed; summarized with '${summarizedBy}' instead.`
            : "";
        return {
          success: true,
          response:
            `[REI] Session compacted${modelLabel}. ` +
            `${beforeCount} → ${afterCount} messages. ` +
            `Older turns were summarized to preserve context window.` +
            fellBack +
            modelWarning,
          newSession: { ...session, messages: compactedMessages },
        };
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        const hint =
          compactorModel && errMsg.toLowerCase().includes("not found")
            ? `\nHint: model "${compactorModel}" was not found. ` +
              (providerName === "ollama"
                ? `Run \`ollama pull ${compactorModel}\` or fix COMPACTOR_MODEL in your .env.`
                : `Check COMPACTOR_MODEL in your .env.`)
            : "";
        return {
          success: false,
          response: `[REI] Error compacting session: ${errMsg}${hint}`,
        };
      }
    }

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
