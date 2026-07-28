import type { CommandHandler, CommandResult, LiveStatusEvent } from "./command-handler.js";
import type { ChatMessage, SessionMode } from "../types.js";
import { saveSession } from "../session-store.js";
import { clearCurrentPlan } from "../plan-tracker.js";
import { clearPromptCache } from "../../prompts/loader.js";
import { generateRepoMap } from "../../tools/repo-map-generator.js";
import { startIndexingWorker } from "../../context/rag/rag-indexer.js";
import { getHelpText } from "../../cli/constants/chat.constants.js";
import { getVersion } from "../../cli/version.js";

const MODE_RE = /^\/mode\s+(\S+)$/;

/**
 * System / misc commands: /mode · /clear · /tdd · /index · /reloadprompts · /help.
 * Extracted verbatim from menu-command-processor (Phase 1 of the refactor — no behavior change).
 */
export const miscCommands: CommandHandler = {
  match: (c) =>
    c === "/reloadprompts" ||
    c === "/clear" ||
    c === "/tdd" ||
    c === "/index" ||
    c === "/help" ||
    c === "/version" ||
    c === "/env" ||
    MODE_RE.test(c),

  run: ({ command: trimmed, session, workspacePath, onStatus, onLiveStatus }): CommandResult => {
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
      saveSession(workspacePath, newMessages, session.mode, session.summary, session.createdAt);
      clearCurrentPlan(workspacePath);
      return {
        success: true,
        response:
          "[REI] Conversation history has been cleared. Starting with a fresh context.",
        newSession: { ...session, messages: newMessages },
        recordInSession: false,
      };
    }

    const modeMatch = trimmed.match(MODE_RE);
    if (modeMatch) {
      const requested = modeMatch[1];
      if (requested === "ask" || requested === "planning" || requested === "agent") {
        const previousMode = session.mode;
        const newMode = requested as SessionMode;
        let messages = [...session.messages];

        if (previousMode === "agent" && newMode !== "agent") {
          // Leaving agent mode: drop ONLY the tool-calling plumbing — role:"tool" results and
          // the assistant messages that carry tool_calls (the ask/planning XML path can't
          // consume those and their request/result pairing breaks). KEEP the conversation prose
          // so the session/context SURVIVES the switch.
          messages = messages
            .filter((m) => m.role !== "tool")
            .map((m) =>
              m.role === "assistant" && m.tool_calls ? { ...m, tool_calls: undefined } : m,
            )
            .filter((m) => !(m.role === "assistant" && !m.content.trim()));
        }

        saveSession(workspacePath, messages, newMode, session.summary, session.createdAt);

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
      }
      process.env.REI_TDD_MODE = "true";
      return {
        success: true,
        response:
          "[REI] TDD Mode activated! Sandbox will now run 'npm run test' during edit validation.",
      };
    }

    if (trimmed === "/index") {
      const emit = onStatus ?? (() => {});
      const live = onLiveStatus ?? (() => {});

      // 1. Generate and persist the AST Skeleton Map (errors logged, no user-facing).
      live({ type: "init", text: `Generating AST skeleton map...` });
      generateRepoMap(workspacePath).catch((err) => {
        console.error("[/index] Repo map error:", err);
      });

      // 2. Start the RAG vector indexing in background with live progress.
      startIndexingWorker(workspacePath, {
        onProgress: (indexed: number, total: number) => {
          live({ type: "progress", text: `Indexing repository... ${indexed}/${total} files` });
        },
        onDone: (message: string) => {
          // Final message goes to transcript via emit (stays in history).
          live({ type: "done", text: `✓ ${message}` });
        },
      });

      return {
        success: true,
        response: "",
      };
    }

    if (trimmed === "/version") {
      return { success: true, response: `[REI] rei ${getVersion()}` };
    }

    if (trimmed === "/help") {
      return { success: true, response: `[REI] Available commands:\n${getHelpText()}` };
    }

    if (trimmed === "/env") {
      const ollamaVars = Object.entries(process.env)
        .filter(([key]) => key.startsWith("OLLAMA"))
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, value]) => `${key}=${value ?? ""}`);

      if (ollamaVars.length === 0) {
        return { success: true, response: "[REI] No OLLAMA environment variables found." };
      }
      return {
        success: true,
        response: `[REI] OLLAMA environment variables:\n${ollamaVars.join("\n")}`,
      };
    }

    // Unreachable: match() guarantees one of the branches above handled it.
    return { success: false, response: "[REI] Unknown command." };
  },
};
