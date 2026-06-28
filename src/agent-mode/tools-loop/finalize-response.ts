import type { ChatMessage } from "../../chat/types.js";
import type { ModelProvider } from "../../providers/model-provider.js";
import { looksLikeAttemptedToolCall } from "./tool-call-detection.js";

/**
 * Builds the final user-facing response when the model finishes (no more tool calls). Extracted
 * from executeAgentTurnWithTools (Phase 2). Two concerns:
 *  1. RECAP: if the model applied changes but didn't explain them (empty/too-terse reply — common
 *     when thinking is on and narration went to `reasoning`), request a concise plain-text recap.
 *  2. SAFETY NET: if NOTHING was applied yet the model wrote edit-like text, prepend a loud warning
 *     so the user doesn't assume a change was made.
 */
export async function buildFinalResponse(params: {
  /** The model's final message content. */
  content: string;
  /** First-turn prose explanation (prepended if distinct from content). */
  firstTurnExplanation: string;
  /** Files with pending/applied virtual edits this turn. */
  modifiedFiles: string[];
  /** Files created directly this turn. */
  createdFiles: string[];
  /** Conversation so far (for the recap turn). */
  currentMessages: ChatMessage[];
  provider: ModelProvider;
  modelOverride?: string;
  /** How many format-correction nudges happened (signals the model "implied" edits). */
  formatCorrections: number;
  emitStatus: (msg: string) => void;
}): Promise<string> {
  const {
    content,
    firstTurnExplanation,
    modifiedFiles,
    createdFiles,
    currentMessages,
    provider,
    modelOverride,
    formatCorrections,
    emitStatus,
  } = params;

  // Prepend the first-turn plan ONLY when it's genuinely different from the final content.
  // `firstTurnExplanation` is stored trimmed, so compare against content.trim() — otherwise a
  // single-turn plain answer whose content has trailing/leading whitespace differs by whitespace
  // alone and gets prepended onto itself (the duplicated-output bug).
  const response =
    firstTurnExplanation && content.trim() !== firstTurnExplanation
      ? firstTurnExplanation + "\n\n" + content
      : content;

  const hasChanges = modifiedFiles.length > 0 || createdFiles.length > 0;
  let finalResponse = response.trim();

  // RECAP: applied changes but no clear summary → request one (plain text, no tools).
  if (hasChanges && finalResponse.length < 40) {
    emitStatus("📋  [REI] Generating summary...");
    const fileList = [...new Set([...modifiedFiles, ...createdFiles])];
    const summaryMessages: ChatMessage[] = [
      ...currentMessages,
      { role: "assistant", content },
      {
        role: "user",
        content:
          "Task complete. Write a concise recap for the user, plain text only (no tool " +
          "calls): for EACH file you changed, one line — `<file>: <what you changed and why>`. " +
          `Files changed this turn: ${fileList.join(", ")}.`,
      },
    ];
    const generated = await provider
      .completeChat(summaryMessages, { model: modelOverride })
      .catch(() => "");
    // Always guarantee a file list, even if the model's recap is weak/failed.
    finalResponse =
      generated.trim() ||
      `Done. Changes applied to:\n${fileList.map((f) => `- ${f}`).join("\n")}`;
  }

  // SAFETY NET: "said it did something but didn't".
  const appliedNothing = modifiedFiles.length === 0 && createdFiles.length === 0;
  const impliedEdits =
    formatCorrections > 0 || looksLikeAttemptedToolCall(content) || /```/.test(content);
  if (appliedNothing && impliedEdits) {
    finalResponse =
      `\x1b[1m\x1b[33m⚠️  NO FILE WAS CHANGED.\x1b[0m The model described an edit but never ` +
      `emitted an \`edit_file\`/\`create_file\` tool call, so nothing was applied to disk. ` +
      `Re-run the step or rephrase the request.\n\n` +
      finalResponse;
  }

  return finalResponse;
}
