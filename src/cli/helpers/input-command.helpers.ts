import { processMenuCommand } from "../../chat/menu-command-processor.js";
import type { InputHandlerContext } from "../models/input-handler.types.js";
import { createModelProvider } from "../../providers/provider-factory.js";
import { Agent } from "../../core/agent.js";
import { handleInputTurn } from "./input-turn.helpers.js";
import { grabClipboardImage } from "../../tools/clipboard-image.js";
import { extractImagePaths, extractPdfPaths } from "../../tools/vision-sidecar.js";
import { saveSession } from "../../chat/session-store.js";
import * as fs from "fs";

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

  // /paste-image [text]: grab an image from the clipboard (macOS) into a temp file,
  // then run a normal turn referencing it so the vision sidecar describes it.
  if (trimmed === "/paste-image" || trimmed.startsWith("/paste-image ")) {
    const extra = trimmed.slice("/paste-image".length).trim();
    const grab = await grabClipboardImage();
    if (!grab.ok || !grab.filePath) {
      actions.pushTranscript(
        `\x1b[33m⚠️  ${grab.error ?? "Could not read image from clipboard."}\x1b[0m`,
      );
      actions.draw();
      return true;
    }
    const prompt = extra ? `${extra} ${grab.filePath}` : grab.filePath;
    const displayText = extra ? `📋🖼️  ${extra}` : "📋🖼️  (pasted image)";
    try {
      await handleInputTurn(prompt, ctx, { displayText });
    } finally {
      // Temp clipboard capture is only needed for this turn's description.
      try {
        fs.unlinkSync(grab.filePath);
      } catch {
        /* best-effort cleanup */
      }
    }
    return true;
  }

  // A dragged-in attachment path is absolute (starts with "/" on macOS/Linux) and would
  // otherwise be misread as an unknown slash-command. If the input references an existing
  // image OR pdf file, it's not a command — let it flow to the turn so the OCR/vision
  // sidecar handles it.
  if (
    extractImagePaths(trimmed, ctx.workspacePath).length > 0 ||
    extractPdfPaths(trimmed, ctx.workspacePath).length > 0
  ) {
    return false;
  }

  // Delegate to the centralized command processor. The onStatus callback streams live progress
  // (e.g. /ask-document indexing) to the transcript so slow commands don't look frozen.
  const result = await processMenuCommand(
    trimmed,
    session,
    ctx.workspacePath,
    agent.provider,
    (message: string) => {
      actions.pushTranscript(`\x1b[2m${message}\x1b[0m`);
      actions.draw();
    },
  );

  if (result.success) {
    actions.pushTranscript(result.response);

    // Persist commands that asked to be recorded (e.g. /ask-document) into the session so the
    // Q&A is part of the conversation history — enabling follow-ups and recall, and not lost.
    if (result.recordInSession && !result.newSession) {
      session.messages.push({ role: "user", content: trimmed });
      session.messages.push({ role: "assistant", content: result.response });
      saveSession(ctx.workspacePath, session.messages, session.mode);
    }

    if (result.recreateAgent) {
      // Tear down the old agent's MCP connections before swapping in a new one,
      // then reconnect so the fresh agent has the same tools available.
      await ctx.agent.disposeMcp();
      const newProvider = createModelProvider();
      ctx.agent = new Agent(newProvider, ctx.workspacePath);
      try {
        await ctx.agent.connectMcp();
      } catch (error) {
        console.error(
          `⚠️  MCP reconnect failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    if (result.newSession) {
      Object.assign(session, result.newSession);
    }

    // Handle automatic execution (e.g., /runplan) via the full streaming pipeline
    // so patch diffs and live output are shown correctly.
    if (result.autoExecute) {
      const { prompt } = result.autoExecute;
      const stageMatch = prompt.match(/\[RUNPLAN STAGE (\d+)\]/i);
      const displayText = stageMatch
        ? `[RUNPLAN STAGE ${stageMatch[1]}]`
        : "[RUNPLAN]";
      await handleInputTurn(prompt, ctx, { displayText });
    }
    return true;
  }

  // Any slash-prefixed input is treated as a command. If it fails,
  // surface the command error and do not fall through to model execution.
  if (trimmed.startsWith("/")) {
    actions.pushTranscript(result.response);
    return true;
  }

  return false;
}
