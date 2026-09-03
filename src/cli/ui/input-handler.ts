import { commandInsertText } from "../constants/chat.constants.js";
import { ActivePalette } from "../models/chat.types.js";
import type { InputHandlerContext } from "../models/input-handler.types.js";
import { clamp } from "../helpers/terminal.helpers.js";
import { handleInputCommand } from "../helpers/input-command.helpers.js";
import { handleInputTurn } from "../helpers/input-turn.helpers.js";
import { extractSREdits } from "../../agent-mode/response-handler.js";
import { formatCodeDiff } from "../markdown-renderer.js";

export class InputHandler {
  public static async submitInput(ctx: InputHandlerContext): Promise<void> {
    const { state, actions } = ctx;

    // NOTE: Check if the input handler is currently busy processing another input
    if (state.busy) return;

    const activePalette = actions.getActivePalette();
    const submittedInput = state.inputBuffer;
    const trimmed = state.inputBuffer.trim();

    // NOTE: Handle selection from the mention palette (file/directory suggestions)
    if (InputHandler.handleMentionPaletteSelection(ctx, activePalette)) {
      return;
    }

    // NOTE: Handle selection from the command palette (/help, /mode, etc.)
    if (await InputHandler.handleCommandPaletteSelection(ctx, activePalette)) {
      return;
    }

    await InputHandler.handleTypedSubmission(ctx, submittedInput, trimmed);
  }

  private static handleMentionPaletteSelection(
    ctx: InputHandlerContext,
    activePalette: ActivePalette,
  ): boolean {
    const { state, actions } = ctx;
    const palette = activePalette.items;

    if (activePalette.kind !== "mention" || palette.length === 0) {
      return false;
    }

    const mentionContext = actions.getMentionContext();
    if (!mentionContext) {
      return true;
    }

    const selected =
      activePalette.items[
        clamp(state.selectedCommandIndex, 0, activePalette.items.length - 1)
      ];
    const selectedText = `@${selected.value}`;
    const trailing = state.inputBuffer.slice(mentionContext.end);
    const needsSpace =
      !selected.isDir && (trailing.length === 0 || !/^\s/.test(trailing));
    const suffix = needsSpace ? " " : "";

    state.inputBuffer = `${state.inputBuffer.slice(0, mentionContext.start)}${selectedText}${suffix}${state.inputBuffer.slice(mentionContext.end)}`;
    state.inputCursor =
      mentionContext.start + selectedText.length + suffix.length;
    state.selectedCommandIndex = 0;
    state.paletteClosed = !selected.isDir;
    actions.draw();

    return true;
  }

  private static async handleCommandPaletteSelection(
    ctx: InputHandlerContext,
    activePalette: ActivePalette,
  ): Promise<boolean> {
    const { state, actions } = ctx;
    const palette = activePalette.items;

    if (activePalette.kind !== "command" || palette.length === 0) {
      return false;
    }

    const selected =
      activePalette.items[
        clamp(state.selectedCommandIndex, 0, activePalette.items.length - 1)
      ];

    if (selected.requiresArgs) {
      state.inputBuffer = commandInsertText(selected.command);
      state.inputCursor = state.inputBuffer.length;
      state.selectedCommandIndex = 0;
      state.paletteClosed = true;
      state.historyCursor = undefined;
      state.historyDraft = "";
      actions.draw();
      return true;
    }

    actions.rememberHistory(selected.command);
    actions.resetInput();
    state.paletteClosed = true;

    const wasCommand = await handleInputCommand(selected.command, ctx);
    actions.draw();

    return !state.running || wasCommand;
  }

  private static async handleTypedSubmission(
    ctx: InputHandlerContext,
    submittedInput: string,
    trimmed: string,
  ): Promise<void> {
    const { state, actions, session, agent, workspacePath } = ctx;

    actions.resetInput();
    actions.draw();

    if (!trimmed) {
      return;
    }

    actions.rememberHistory(submittedInput);
    // Block concurrent input while a command runs. Most commands are instant, but some are slow
    // and async (e.g. /ask-document indexes + embeds a whole document) — without this guard the
    // user could submit more inputs that interleave with the in-flight command and clobber its
    // session save. handleInputTurn manages its own busy flag; this covers the command path.
    state.busy = true;
    let wasCommand: boolean;
    try {
      wasCommand = await handleInputCommand(trimmed, ctx);
    } finally {
      state.busy = false;
    }
    actions.draw();
    if (!state.running || wasCommand) {
      return;
    }

    // Procesar el turno del usuario
    //const rawResponse = await agent.runTurn(session, trimmed);
    //session.messages.push({ role: "assistant", content: rawResponse });

    // Extraer ediciones de código
    //const edits = extractSREdits(rawResponse);

    //if (edits.length > 0) {
    // Formatear las diferencias de código
    //edits.forEach((edit) => {
    //const formattedDiff = formatCodeDiff(edit.search, edit.replace);
    //actions.pushTranscript(`\n\n--- File: ${edit.file} ---\n\n${formattedDiff}`);
    // });

    // Actualizar el estado y dibujar la pantalla
    //actions.draw();
    // return;
    // }

    await handleInputTurn(trimmed, ctx);
  }
}
