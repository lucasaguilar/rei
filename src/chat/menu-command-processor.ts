import type { ChatMessage, ChatSession, SessionMode } from "./types.js";
import { getHelpText } from "../cli/constants/chat.constants.js";
import {
  archiveCurrentSession,
  listSessions,
  loadSessionById,
  saveSession,
} from "./session-store.js";
import { compactSession } from "./compactor.js";
import { startIndexingWorker } from "../context/rag/rag-indexer.js";
import { generateRepoMap } from "../tools/repo-map-generator.js";
import type { ModelProvider } from "../providers/model-provider.js";
import { clearPromptCache } from "../prompts/loader.js";

export interface CommandResult {
  success: boolean;
  response: string;
  newSession?: ChatSession;
  autoExecute?: { prompt: string };
  recordInSession?: boolean;
}

export async function processMenuCommand(
  command: string,
  session: ChatSession,
  workspacePath: string,
  provider: ModelProvider,
): Promise<CommandResult> {
  const trimmed = command.trim();

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

  if (trimmed === "/session new") {
    const archivedName =
      session.messages.length > 0 ? archiveCurrentSession(workspacePath) : null;
    const newSession: ChatSession = { messages: [], mode: session.mode };

    saveSession(workspacePath, newSession.messages, newSession.mode);

    return {
      success: true,
      response: archivedName
        ? `[REI] Archived current session as ${archivedName}. Started a new ${newSession.mode} session.`
        : `[REI] Started a new ${newSession.mode} session.`,
      newSession,
      recordInSession: false,
    };
  }

  if (trimmed === "/session list") {
    const sessions = listSessions(workspacePath);
    if (sessions.length === 0) {
      return {
        success: true,
        response: "[REI] No archived sessions found.",
      };
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
      return {
        success: false,
        response: `[REI] Session not found: ${id}`,
      };
    }

    const currentHadContent = session.messages.length > 0;
    const archivedName = currentHadContent
      ? archiveCurrentSession(workspacePath)
      : null;

    saveSession(
      workspacePath,
      loaded.messages,
      loaded.mode,
      loaded.summary,
      loaded.createdAt,
    );

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

  if (trimmed === "/reloadprompts") {
    clearPromptCache();
    return {
      success: true,
      response:
        "[REI] Prompt cache cleared. All prompts will be reloaded from disk on next request.",
    };
  }
  if (trimmed === "/clear") {
    const newMessages: ChatMessage[] = [];
    saveSession(
      workspacePath,
      newMessages,
      session.mode,
      session.summary,
      session.createdAt,
    );
    return {
      success: true,
      response:
        "[REI] Conversation history has been cleared. Starting with a fresh context.",
      newSession: { ...session, messages: newMessages },
      recordInSession: false,
    };
  }

  if (trimmed === "/compact") {
    try {
      const compactedMessages = await compactSession({
        messages: session.messages,
        provider: provider,
        modelOverride: process.env.COMPACTOR_MODEL,
      });
      saveSession(
        workspacePath,
        compactedMessages,
        session.mode,
        session.summary,
        session.createdAt,
      );
      return {
        success: true,
        response:
          "[REI] Session compacted successfully. Older messages were summarized to optimize memory while preserving key technical decisions.",
        newSession: { ...session, messages: compactedMessages },
      };
    } catch (err) {
      return {
        success: false,
        response: `Error compacting session: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  if (trimmed === "/runplan") {
    const lastPlanMsg = [...session.messages]
      .reverse()
      .find(
        (m) =>
          m.role === "assistant" &&
          m.content &&
          m.content.toLowerCase().includes("plan"),
      );

    if (!lastPlanMsg) {
      return {
        success: false,
        response: "[RUNPLAN] No plan found in session.",
      };
    }

    const fileRegex =
      /([\w\-/]+\.(ts|js|json|md|tsx|jsx|yml|yaml|css|scss|html|cjs|mjs))/gi;
    const files = Array.from(
      new Set(lastPlanMsg.content!.match(fileRegex) || []),
    );

    if (files.length === 0) {
      return {
        success: false,
        response:
          "[RUNPLAN] No files detected in plan. Please ensure the plan lists file names.",
      };
    }

    const planPrompt = `Ejecutá el siguiente plan sobre estos archivos:\n\nPLAN:\n${lastPlanMsg.content}\n\nARCHIVOS:\n${files.join(", ")}`;

    const newMode = "agent" as SessionMode;
    saveSession(
      workspacePath,
      session.messages,
      newMode,
      session.summary,
      session.createdAt,
    );

    return {
      success: true,
      response: `[REI] Switching to AGENT mode to execute the plan. Target files: ${files.join(", ")}`,
      newSession: { ...session, mode: newMode },
      autoExecute: { prompt: planPrompt },
    };
  }

  const modeMatch = trimmed.match(/^\/mode\s+(\S+)$/);
  if (modeMatch) {
    const requested = modeMatch[1];
    if (
      requested === "ask" ||
      requested === "planning" ||
      requested === "agent"
    ) {
      const previousMode = session.mode;
      const newMode = requested as SessionMode;
      let messages = [...session.messages];

      if (previousMode === "agent" && newMode !== "agent") {
        messages = messages.filter((m) => m.role === "system");
      }

      saveSession(
        workspacePath,
        messages,
        newMode,
        session.summary,
        session.createdAt,
      );

      const modeDescriptions: Record<SessionMode, string> = {
        ask: "Mode switched to ASK. I will answer questions based on the repository context without proposing changes.",
        planning:
          "Mode switched to PLANNING. I will help you design a technical plan for your changes.",
        agent:
          "Mode switched to AGENT. I am now authorized to execute tasks, modify files, and apply patches.",
      };

      return {
        success: true,
        response: `[REI] ${modeDescriptions[newMode]}`,
        newSession: { ...session, mode: newMode, messages },
      };
    }
    return {
      success: false,
      response: `Unknown mode: ${requested}. Available: ask, planning, agent`,
    };
  }

  if (trimmed === "/tdd") {
    if (process.env.REI_TDD_MODE === "true") {
      process.env.REI_TDD_MODE = "false";
      return {
        success: true,
        response: "[REI] TDD Mode deactivated. Sandbox will only check types.",
      };
    } else {
      process.env.REI_TDD_MODE = "true";
      return {
        success: true,
        response:
          "[REI] TDD Mode activated! Sandbox will now run 'npm run test' during edit validation.",
      };
    }
  }

  if (trimmed === "/index") {
    // 1. Generate and persist the AST Skeleton Map (errors are logged, not swallowed)
    generateRepoMap(workspacePath).catch((err) =>
      console.error("[/index] Repo map error:", err),
    );

    // 2. Start the RAG vector indexing
    startIndexingWorker(workspacePath, {
      onDone: (msg) => console.log(`[RAG Indexer] ${msg}`),
    });
    return {
      success: true,
      response:
        "[REI] Full repository indexing started. The AST skeleton map is updating and RAG indexing is running in the background.",
    };
  }

  if (trimmed === "/help") {
    return {
      success: true,
      response: `[REI] Available commands:\n${getHelpText()}`,
    };
  }

  return {
    success: false,
    response: `Unknown command: ${trimmed}`,
  };
}
