import type { SessionMode } from "../../chat/types.js";
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
    const { generateRepoMap } =
      await import("../../tools/repo-map-generator.js");
    const map = generateRepoMap(ctx.workspacePath);
    const lines = map.split("\n").length;
    actions.pushTranscript(
      `[REPO MAP] Regenerated successfully (${lines} lines).`,
    );
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
