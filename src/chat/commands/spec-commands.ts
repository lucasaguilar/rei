import type { CommandHandler, CommandResult } from "./command-handler.js";
import { saveSession } from "../session-store.js";
import {
  saveSpecToFile,
  loadSpecFromFile,
  isSpecMessage,
} from "../spec-tracker.js";

/**
 * `/savespec <name>` · `/loadspec <name>` — persist/ingest a write-spec spec for the SDD flow.
 * Extracted verbatim from menu-command-processor (Phase 1 of the refactor — no behavior change).
 */
export const specCommands: CommandHandler = {
  match: (c) => c.startsWith("/savespec") || c.startsWith("/loadspec"),

  run: ({ command: trimmed, session, workspacePath }): CommandResult => {
    if (trimmed.startsWith("/savespec")) {
      const saveMatch = trimmed.match(/^\/savespec\s+(\S+)$/i);
      if (!saveMatch) {
        return { success: false, response: "[REI] Invalid format. Use: /savespec <name>" };
      }

      const specName = saveMatch[1];
      const lastSpecMsg = [...session.messages]
        .reverse()
        .find((m) => m.role === "assistant" && m.content && isSpecMessage(m.content));

      if (!lastSpecMsg || !lastSpecMsg.content) {
        return {
          success: false,
          response:
            "[REI] No spec was found in this session to save. Run /spec <task> to write one " +
            "(it also saves it to .rei/specs/), or /loadspec <name> to bring an existing one in.",
        };
      }

      try {
        const savedPath = saveSpecToFile(workspacePath, specName, lastSpecMsg.content);
        return { success: true, response: `[REI] Spec saved successfully to: ${savedPath}` };
      } catch (err) {
        return {
          success: false,
          response: `[REI] Error saving spec: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }

    if (trimmed.startsWith("/loadspec")) {
      const loadMatch = trimmed.match(/^\/loadspec\s+(\S+)$/i);
      if (!loadMatch) {
        return { success: false, response: "[REI] Invalid format. Use: /loadspec <name>" };
      }

      const specName = loadMatch[1];
      try {
        const specContent = loadSpecFromFile(workspacePath, specName);

        // Ingest the spec as an assistant message so the next planning turn
        // (micro-task-decomposition) consumes it as the scope contract.
        const updatedMessages = [
          ...session.messages,
          { role: "assistant" as const, content: specContent },
        ];

        saveSession(
          workspacePath,
          updatedMessages,
          session.mode,
          session.summary,
          session.createdAt,
        );

        return {
          success: true,
          response: `[REI] Spec '${specName}' loaded into the session. Decompose it with the micro-task-decomposition skill.`,
          newSession: { ...session, messages: updatedMessages },
        };
      } catch (err) {
        return {
          success: false,
          response: `[REI] Error loading spec: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }

    // Unreachable: match() guarantees one of the branches above handled it.
    return { success: false, response: "[REI] Unknown spec command." };
  },
};
