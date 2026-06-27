import * as fs from "node:fs";
import * as path from "node:path";
import type { ChatSession, SessionMode } from "./types.js";
import { saveSession } from "./session-store.js";
import { compactSession } from "./compactor.js";
import type { ModelProvider } from "../providers/model-provider.js";
import { dispatchCommand } from "./commands/registry.js";

export interface CommandResult {
  success: boolean;
  response: string;
  newSession?: ChatSession;
  autoExecute?: { prompt: string };
  recordInSession?: boolean;
  recreateAgent?: boolean;
}

export async function processMenuCommand(
  command: string,
  session: ChatSession,
  workspacePath: string,
  provider: ModelProvider,
  onStatus?: (message: string) => void,
): Promise<CommandResult> {
  const trimmed = command.trim();

  // Registry-migrated commands (see docs/refactor-plan.md, Phase 1). Returns null for commands
  // not yet migrated → they fall through to the legacy if/else below.
  const dispatched = await dispatchCommand({
    command: trimmed,
    session,
    workspacePath,
    provider,
    onStatus,
  });
  if (dispatched) return dispatched;

  if (trimmed === "/compact") {
    const nonSystem = session.messages.filter((m) => m.role !== "system");
    if (nonSystem.length < 2) {
      return {
        success: false,
        response: "[REI] Session is too short to compact (nothing to summarize).",
      };
    }

    const compactorModel = process.env.COMPACTOR_MODEL;

    // Warn if model name looks like OpenRouter format but provider is Ollama
    const providerName = (process.env.MODEL_PROVIDER ?? "").toLowerCase();
    const modelWarning =
      compactorModel && providerName === "ollama" && compactorModel.includes("/")
        ? `\n⚠️  COMPACTOR_MODEL="${compactorModel}" looks like OpenRouter format. ` +
          `For Ollama use the local name (e.g. qwen3:4b). ` +
          `Run \`ollama pull qwen3:4b\` and set COMPACTOR_MODEL=qwen3:4b.`
        : "";

    try {
      const beforeCount = nonSystem.length;
      const compactedMessages = await compactSession({
        messages: session.messages,
        provider,
        modelOverride: compactorModel,
        force: true, // manual /compact always bypasses the auto-threshold
      });
      const afterCount = compactedMessages.filter((m) => m.role !== "system").length;

      saveSession(
        workspacePath,
        compactedMessages,
        session.mode,
        session.summary,
        session.createdAt,
      );

      const modelLabel = compactorModel ? ` (model: ${compactorModel})` : "";
      return {
        success: true,
        response:
          `[REI] Session compacted${modelLabel}. ` +
          `${beforeCount} → ${afterCount} messages. ` +
          `Older turns were summarized to preserve context window.` +
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

  if (trimmed === "/env") {
    const ollamaVars = Object.entries(process.env)
      .filter(([key]) => key.startsWith("OLLAMA"))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key}=${value ?? ""}`);

    if (ollamaVars.length === 0) {
      return {
        success: true,
        response: "[REI] No OLLAMA environment variables found.",
      };
    }

    return {
      success: true,
      response: `[REI] OLLAMA environment variables:\n${ollamaVars.join("\n")}`,
    };
  }

  return {
    success: false,
    response: `Unknown command: ${trimmed}`,
  };
}
