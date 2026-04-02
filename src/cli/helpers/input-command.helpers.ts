import type { SessionMode } from "../../chat/types.js";
import {
  hasRagIndex,
  startIndexingWorker,
} from "../../context/rag/rag-indexer.js";
import {
  formatTypeScriptCompileResult,
  runTypeScriptCompileCheck,
} from "../../tools/typescript-compile-check.js";
import { formatPatchForTerminal } from "../../tools/patch-generator.js";
import { HELP_TEXT } from "../constants/chat.constants.js";
import type { InputHandlerContext } from "../models/input-handler.types.js";
import { saveSession } from "../../chat/session-store.js";

export async function handleInputCommand(
  trimmed: string,
  ctx: InputHandlerContext,
): Promise<boolean> {
  const { state, agent, session, actions } = ctx;

  if (trimmed === "/exit") {
    actions.pushTranscript("Goodbye!");
    actions.draw();
    state.running = false;
    return true;
  }

  if (trimmed === "/clear") {
    session.messages = [];
    ctx.transcript.length = 0;
    actions.pushTranscript("History cleared.");
    return true;
  }

  if (trimmed === "/help") {
    actions.pushTranscript(HELP_TEXT);
    return true;
  }

  if (trimmed === "/pending") {
    const pending = agent.getPendingPatches();
    if (pending.length === 0) {
      actions.pushTranscript("No pending patches.");
      return true;
    }

    const assessment = await agent.assessPendingPatchesSafety();
    actions.pushTranscript(`Pending patches: ${pending.length}`);
    actions.pushTranscript(
      `Workspace quality: ${assessment.workspaceQualityOk ? "ok" : "failed"}`,
    );

    for (const item of assessment.items) {
      actions.pushTranscript(`File: ${item.proposal.file}`);
      actions.pushTranscript(
        `Reason: ${item.proposal.description || "(no description)"}`,
      );
      actions.pushTranscript(`Applicable: ${item.applicable ? "yes" : "no"}`);
      actions.pushTranscript(`Safe: ${item.safe ? "yes" : "no"}`);
      if (item.issues.length > 0) {
        actions.pushTranscript(`Issues: ${item.issues.join(" | ")}`);
      }
      actions.pushTranscript(formatPatchForTerminal(item.proposal.patch));
    }

    if (!assessment.workspaceQualityOk && assessment.workspaceQualityStderr) {
      actions.pushTranscript(
        `Workspace check stderr: ${assessment.workspaceQualityStderr.trim()}`,
      );
    }

    actions.pushTranscript("Use /confirm to apply, or /discard to clear them.");
    return true;
  }

  if (trimmed === "/discard") {
    const discarded = agent.clearPendingPatches();
    actions.pushTranscript(
      discarded > 0
        ? `Discarded ${discarded} pending patch(es).`
        : "No pending patches.",
    );
    return true;
  }

  if (trimmed === "/confirm" || trimmed === "/confirm --dry-run") {
    const dryRun = trimmed.includes("--dry-run");
    const pending = agent.getPendingPatches();
    if (pending.length === 0) {
      actions.pushTranscript("No pending patches to apply.");
      return true;
    }

    state.busy = true;
    state.activeStatus = "producing_response";
    actions.startSpinner();
    actions.draw();

    try {
      const result = await agent.applyPendingPatches({ dryRun });
      if (result.results.length === 0) {
        actions.pushTranscript("No pending patches to apply.");
        return true;
      }

      actions.pushTranscript(
        dryRun
          ? "Patch dry-run completed."
          : result.success
            ? "Patches applied."
            : "Patch apply completed with errors.",
      );

      for (const item of result.results) {
        const status = item.applied
          ? "applied"
          : item.skipped
            ? "skipped"
            : "failed";
        actions.pushTranscript(`- ${item.file}: ${status}`);
        if (item.validationErrors.length > 0) {
          actions.pushTranscript(
            `  validation: ${item.validationErrors.join(" | ")}`,
          );
        }
        if (item.stderr) {
          actions.pushTranscript(`  stderr: ${item.stderr.trim()}`);
        }
      }

      if (!dryRun && result.success) {
        state.activeStatus = "producing_response";
        actions.draw();
        try {
          const compileResult = await runTypeScriptCompileCheck(
            ctx.workspacePath,
          );
          for (const line of formatTypeScriptCompileResult(compileResult)) {
            actions.pushTranscript(line);
          }
        } catch (compileErr: unknown) {
          actions.pushTranscript(
            `[tsc] check skipped: ${compileErr instanceof Error ? compileErr.message : String(compileErr)}`,
          );
        }
      }
    } catch (err: unknown) {
      actions.pushTranscript(
        `Error: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      state.busy = false;
      state.activeStatus = undefined;
      actions.stopSpinner();

      saveSession(
        ctx.workspacePath,
        session.messages,
        session.mode,
        session.summary,
        session.createdAt,
      );
    }

    return true;
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
      session.mode = requested as SessionMode;
      if (previousMode === "agent" && session.mode !== "agent") {
        const systemMessages = session.messages.filter(
          (m) => m.role === "system",
        );
        session.messages = systemMessages;
      }
      actions.pushTranscript(`[REI] Mode switched to: ${session.mode}`);
    } else {
      actions.pushTranscript(
        `Unknown mode: ${requested}. Available modes: ask, planning, agent`,
      );
    }
    return true;
  }

  if (trimmed === "/compact") {
    state.busy = true;
    state.activeStatus = "compacting_memory";
    actions.startSpinner();
    actions.draw();

    try {
      const { compactSession } = await import("../../chat/compactor.js");
      session.messages = await compactSession({
        messages: session.messages,
        provider: ctx.agent.provider,
        modelOverride: process.env.COMPACTOR_MODEL,
      });
      saveSession(
        ctx.workspacePath,
        session.messages,
        session.mode,
        session.summary,
        session.createdAt,
      );
      actions.pushTranscript("[SESSION] Conversation compacted.");
    } catch (err: unknown) {
      actions.pushTranscript(
        `Error: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      state.busy = false;
      state.activeStatus = undefined;
      actions.stopSpinner();
    }
    return true;
  }

  if (trimmed === "/index") {
    const { workspacePath, actions: act } = ctx;
    const already = hasRagIndex(workspacePath);
    act.pushTranscript(
      already
        ? "[RAG] Re-indexing workspace in background..."
        : "[RAG] Starting first-time index in background...",
    );
    startIndexingWorker(workspacePath, {
      onProgress: (indexed, total) => {
        act.pushTranscript(`[RAG] Indexing... ${indexed}/${total} files`);
        act.draw();
      },
      onDone: (message) => {
        act.pushTranscript(`[RAG] ${message}`);
        act.draw();
      },
    });
    return true;
  }

  return false;
}
