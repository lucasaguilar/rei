import type { SessionMode } from "../../chat/types.js";
import {
  hasRagIndex,
  startIndexingWorker,
} from "../../context/rag/rag-indexer.js";
import {
  formatTypeScriptCompileResult,
  runTypeScriptCompileCheck,
} from "../../tools/typescript-compile-check.js";
import type { AgentSREdit } from "../../contracts/agent-interaction.types.js";
import { HELP_TEXT } from "../constants/chat.constants.js";
import type { InputHandlerContext } from "../models/input-handler.types.js";
import {
  saveSession,
  archiveCurrentSession,
  listSessions,
  loadSessionById,
} from "../../chat/session-store.js";


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
    saveSession(
      ctx.workspacePath,
      session.messages,
      session.mode,
      session.summary,
      session.createdAt,
    );
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
      actions.pushTranscript(`--- Search Block ---\n${item.proposal.search}\n--- Replace Block ---\n${item.proposal.replace}`);
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

  if (trimmed === "/confirm" || trimmed === "/confirm --dry-run" || trimmed === "/confirm --force") {
    const dryRun = trimmed.includes("--dry-run");
    const force = trimmed.includes("--force");
    const skipTscCheck = dryRun || force;
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

      }

      if (!dryRun && !skipTscCheck && result.success) {
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

  if (trimmed === "/session" || trimmed === "/session info") {
    const nonSystem = session.messages.filter((m) => m.role !== "system");
    const turns = Math.floor(nonSystem.length / 2);
    actions.pushTranscript(`Mode: ${session.mode}`);
    actions.pushTranscript(`Turns: ${turns}`);
    actions.pushTranscript(`Created: ${session.createdAt ?? "unknown"}`);
    return true;
  }

  if (trimmed === "/session new") {
    const archived = archiveCurrentSession(ctx.workspacePath);
    session.messages = [];
    ctx.transcript.length = 0;
    saveSession(ctx.workspacePath, [], session.mode, undefined, undefined);
    actions.pushTranscript(
      archived
        ? `[SESSION] Archived as ${archived}. Starting fresh.`
        : "[SESSION] Started fresh session.",
    );
    return true;
  }

  if (trimmed === "/session list") {
    const sessions = listSessions(ctx.workspacePath);
    if (sessions.length === 0) {
      actions.pushTranscript("[SESSION] No archived sessions.");
    } else {
      for (const s of sessions) {
        actions.pushTranscript(
          `  ${s.id}  [${s.mode}]  ${new Date(s.updatedAt).toLocaleString()}  (${s.turns} turns)${s.summary ? "  " + s.summary : ""}`,
        );
      }
    }
    return true;
  }

  const sessionLoadMatch = trimmed.match(/^\/session\s+load\s+(\S+)$/);
  if (sessionLoadMatch) {
    const id = sessionLoadMatch[1];
    const loaded = loadSessionById(ctx.workspacePath, id);
    if (!loaded) {
      actions.pushTranscript(`[SESSION] Session "${id}" not found.`);
    } else {
      session.messages = loaded.messages;
      session.mode = loaded.mode;
      session.summary = loaded.summary;
      session.createdAt = loaded.createdAt;
      ctx.transcript.length = 0;
      const turns = Math.floor(
        loaded.messages.filter((m) => m.role !== "system").length / 2,
      );
      actions.pushTranscript(
        `[SESSION] Loaded "${id}" (${turns} turns, mode: ${loaded.mode}).`,
      );
    }
    return true;
  }

  return false;
}
