import type { CommandHandler, CommandResult } from "./command-handler.js";
import { saveSession } from "../session-store.js";
import { resolveSessionModel } from "../manual-model.js";
import { compactorModelFor, compactSession } from "../compactor.js";

/**
 * `/compact` — summarise the older half of the conversation to buy back context window.
 *
 * It lived in `session-commands` because it edits the session, but it is not part of the session
 * LIFECYCLE (naming, switching, archiving): it rewrites the history in place and the session goes
 * on. Keeping it there made one file answer to two different questions.
 */
export const compactCommand: CommandHandler = {
  match: (c) => c === "/compact",

  run: async ({ session, workspacePath, provider }): Promise<CommandResult> => {
    const nonSystem = session.messages.filter((m) => m.role !== "system");
    if (nonSystem.length < 2) {
      return {
        success: false,
        response:
          "[REI] Session is too short to compact (nothing to summarize).",
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
      compactorModel &&
      providerName === "ollama" &&
      compactorModel.includes("/")
        ? `\n⚠️  COMPACTOR_MODEL="${compactorModel}" looks like OpenRouter format. ` +
          `For Ollama use the local name (e.g. qwen3:4b). ` +
          `Run \`ollama pull qwen3:4b\` and set COMPACTOR_MODEL=qwen3:4b.`
        : "";

    try {
      const beforeCount = nonSystem.length;
      const {
        messages: compactedMessages,
        skipped,
        model: summarizedBy,
      } = await compactSession({
        messages: session.messages,
        provider,
        modelOverride: compactorModel,
        force: true, // manual /compact always bypasses the auto-threshold
      });
      const afterCount = compactedMessages.filter(
        (m) => m.role !== "system",
      ).length;

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
    // Unreachable: match() guarantees /compact.
    return { success: false, response: "[REI] Unknown compact command." };
  },
};
