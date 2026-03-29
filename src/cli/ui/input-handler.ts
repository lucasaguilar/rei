import { Agent, TurnStatus } from "../../core/agent.js";
import { ChatSession, SessionMode } from "../../chat/types.js";
import { ActivePalette, ChatUIState } from "../models/chat.types.js";
import { clamp } from "../helpers/terminal.helpers.js";
import { HELP_TEXT } from "../constants/chat.constants.js";
import { formatPatchForTerminal } from "../../tools/patch-generator.js";
import { renderMarkdown } from "../markdown-renderer.js";

export interface InputHandlerContext {
  state: ChatUIState;
  agent: Agent;
  session: ChatSession;
  transcript: string[];
  actions: {
    pushTranscript(value: string): void;
    draw(): void;
    startSpinner(): void;
    stopSpinner(): void;
    resetInput(): void;
    rememberHistory(value: string): void;
    getActivePalette(): ActivePalette;
    getMentionContext(): { start: number; end: number; query: string } | undefined;
  };
}

export class InputHandler {
  public static async submitInput(ctx: InputHandlerContext): Promise<void> {
    const { state, actions } = ctx;

    if (state.busy) return;

    const activePalette = actions.getActivePalette();
    const palette = activePalette.items;
    const submittedInput = state.inputBuffer;
    const trimmed = state.inputBuffer.trim();

    if (activePalette.kind === "mention" && palette.length > 0) {
      const mentionContext = actions.getMentionContext();
      if (mentionContext) {
        const selected = activePalette.items[clamp(state.selectedCommandIndex, 0, activePalette.items.length - 1)];
        const selectedText = `@${selected.value}`;
        const trailing = state.inputBuffer.slice(mentionContext.end);
        // NOTE: Match trailing whitespace immediately after cursor to decide if an extra space is needed
        const needsSpace = !selected.isDir && (trailing.length === 0 || !/^\s/.test(trailing));
        const suffix = needsSpace ? " " : "";
        state.inputBuffer =
          `${state.inputBuffer.slice(0, mentionContext.start)}${selectedText}${suffix}${state.inputBuffer.slice(mentionContext.end)}`;
        state.inputCursor = mentionContext.start + selectedText.length + suffix.length;
        state.selectedCommandIndex = 0;
        state.paletteClosed = !selected.isDir;
        actions.draw();
      }
      return;
    }

    if (palette.length > 0 && trimmed === "/") {
      if (activePalette.kind !== "command") {
        actions.draw();
        return;
      }
      const selected = activePalette.items[clamp(state.selectedCommandIndex, 0, activePalette.items.length - 1)];
      if (selected.requiresArgs) {
        state.inputBuffer = selected.command;
        state.inputCursor = state.inputBuffer.length;
        state.selectedCommandIndex = 0;
        state.paletteClosed = true;
        state.historyCursor = undefined;
        state.historyDraft = "";
        actions.draw();
        return;
      }
      actions.rememberHistory(selected.command);
      actions.resetInput();
      const wasCommand = await InputHandler.handleCommand(selected.command, ctx);
      actions.draw();
      if (!state.running || wasCommand) {
        return;
      }
    }

    actions.resetInput();
    actions.draw();

    if (!trimmed) {
      return;
    }

    actions.rememberHistory(submittedInput);
    const wasCommand = await InputHandler.handleCommand(trimmed, ctx);
    actions.draw();
    if (!state.running || wasCommand) {
      return;
    }

    await InputHandler.handleUserTurn(trimmed, ctx);
  }

  private static async handleCommand(trimmed: string, ctx: InputHandlerContext): Promise<boolean> {
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
      actions.pushTranscript(`Workspace quality: ${assessment.workspaceQualityOk ? "ok" : "failed"}`);

      for (const item of assessment.items) {
        actions.pushTranscript(`File: ${item.proposal.file}`);
        actions.pushTranscript(`Reason: ${item.proposal.description || "(no description)"}`);
        actions.pushTranscript(`Applicable: ${item.applicable ? "yes" : "no"}`);
        actions.pushTranscript(`Safe: ${item.safe ? "yes" : "no"}`);
        if (item.issues.length > 0) {
          actions.pushTranscript(`Issues: ${item.issues.join(" | ")}`);
        }
        actions.pushTranscript(formatPatchForTerminal(item.proposal.patch));
      }

      if (!assessment.workspaceQualityOk && assessment.workspaceQualityStderr) {
        actions.pushTranscript(`Workspace check stderr: ${assessment.workspaceQualityStderr.trim()}`);
      }

      actions.pushTranscript("Use /confirm to apply, or /discard to clear them.");
      return true;
    }

    if (trimmed === "/discard") {
      const discarded = agent.clearPendingPatches();
      actions.pushTranscript(discarded > 0 ? `Discarded ${discarded} pending patch(es).` : "No pending patches.");
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
            : (result.success ? "Patches applied." : "Patch apply completed with errors.")
        );

        for (const item of result.results) {
          const status = item.applied ? "applied" : (item.skipped ? "skipped" : "failed");
          actions.pushTranscript(`- ${item.file}: ${status}`);
          if (item.validationErrors.length > 0) {
            actions.pushTranscript(`  validation: ${item.validationErrors.join(" | ")}`);
          }
          if (item.stderr) {
            actions.pushTranscript(`  stderr: ${item.stderr.trim()}`);
          }
        }
      } catch (err: unknown) {
        actions.pushTranscript(`Error: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        state.busy = false;
        state.activeStatus = undefined;
        actions.stopSpinner();
      }

      return true;
    }

    // NOTE: Extract the mode setting command, expecting format "/mode <val>" capturing non-whitespace value
    const modeMatch = trimmed.match(/^\/mode\s+(\S+)$/);
    if (modeMatch) {
      const requested = modeMatch[1];
      if (requested === "ask" || requested === "planning" || requested === "agent") {
        const previousMode = session.mode;
        session.mode = requested as SessionMode;
        if (previousMode === "agent" && session.mode !== "agent") {
          const systemMessages = session.messages.filter((m) => m.role === "system");
          session.messages = systemMessages;
        }
        actions.pushTranscript(`[REI] Mode switched to: ${session.mode}`);
      } else {
        actions.pushTranscript(`Unknown mode: ${requested}. Available modes: ask, planning, agent`);
      }
      return true;
    }

    return false;
  }

  private static async handleUserTurn(trimmed: string, ctx: InputHandlerContext): Promise<void> {
    const { state, agent, session, transcript, actions } = ctx;

    state.busy = true;
    state.activeStatus = "building_context";
    state.spinnerIndex = 0;
    actions.startSpinner();
    actions.draw();

    try {
      let lastStatus: TurnStatus | undefined;
      let buffer = "";
      let liveStart = -1;

      for await (const token of agent.streamTurn(session, trimmed, {
        onStatus: (status) => {
          if (lastStatus === status) return;
          lastStatus = status;
          state.activeStatus = status;

          if (status === "producing_response" && liveStart < 0) {
            actions.pushTranscript("");
            actions.pushTranscript(`You: ${trimmed}`);
            actions.pushTranscript("");
            liveStart = transcript.length;
            transcript.push("");
          }
        },
      })) {
        buffer += token;
        if (liveStart >= 0) {
          const lines = buffer.split("\n");
          transcript.splice(liveStart, transcript.length - liveStart, ...lines);
        }
      }

      if (liveStart >= 0) {
        const rendered = renderMarkdown(buffer);
        const lines = rendered.split("\n");
        transcript.splice(liveStart, transcript.length - liveStart, ...lines);
      } else {
        actions.pushTranscript("");
        actions.pushTranscript(`You: ${trimmed}`);
        actions.pushTranscript("");
        actions.pushTranscript(renderMarkdown(buffer));
      }
      actions.pushTranscript("");
    } catch (err: unknown) {
      actions.pushTranscript(`Error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      state.busy = false;
      state.activeStatus = undefined;
      actions.stopSpinner();
      actions.draw();
    }
  }
}
