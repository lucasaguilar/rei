import { processMenuCommand } from "../../chat/menu-command-processor.js";
import { looksLikeCommand } from "../../chat/commands/command-syntax.js";
import type { InputHandlerContext } from "../models/input-handler.types.js";
import { createModelProvider } from "../../providers/provider-factory.js";
import { Agent } from "../../core/agent.js";
import { handleInputTurn } from "./input-turn.helpers.js";
import { displayUserLabel } from "./chat.helpers.js";
import { addContextReading } from "./turn-display.helpers.js";
import { refreshStickyReading } from "./startup-gauge.helper.js";
import { grabClipboardImage } from "../../tools/clipboard-image.js";
import { saveSession } from "../../chat/session-store.js";
import * as fs from "fs";
import { LiveStatusEvent } from "../../chat/commands/command-handler.js";

/**
 * The label shown above an auto-executed turn. Every autoExecute prompt opens with its own tag —
 * `[SPEC]`, `[DECOMPOSE]`, `[RUNPLAN]`, `[RUNPLAN STAGE n]` — so it is read from the prompt rather
 * than assumed to be runplan, which used to print "[RUNPLAN]" over a /spec or /decompose turn.
 * Falls back to the command the user typed when a prompt carries no tag.
 */
export function autoExecuteLabel(prompt: string, typed: string): string {
  return prompt.match(/^\[[^\]\n]+\]/)?.[0] ?? typed;
}

export async function handleInputCommand(
  trimmed: string,
  ctx: InputHandlerContext,
): Promise<boolean> {
  const { state, agent, session, actions } = ctx;

  if (trimmed === "/exit") {
    // Clear the current prompt line, then write farewell directly to stdout.
    // No draw() call — avoids the prompt overwriting our message.
    process.stdout.write("\x1b[2K"); // erase prompt line in place
    process.stdout.write("\nGoodbye!\n");
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

  // Text that merely starts with a slash is not a command — an absolute path is the everyday case
  // (a dragged-in file, a question about one). This used to be handled only for images and PDFs,
  // by looking up whether the path existed; looksLikeCommand answers it for every path, by syntax,
  // and for files that do not exist yet too.
  if (!looksLikeCommand(trimmed)) {
    return false;
  }

  // Delegate to the centralized command processor. The onStatus callback streams live progress
  // (e.g. /ask-document indexing) to the transcript so slow commands don't look frozen.
  // The onLiveStatus handler drives the status bar + spinner for long-running operations like /index.
  const onLiveStatus = (event: LiveStatusEvent) => {
    switch (event.type) {
      case "init":
        state.activeStatus = "indexing_repository";
        state.activeStatusText = event.text;
        state.spinnerIndex = 0;
        actions.startSpinner();
        break;
      case "progress":
        state.activeStatusText = event.text;
        break;
      case "done":
        state.activeStatus = undefined;
        state.activeStatusText = undefined;
        actions.pushTranscript(`\x1b[32m${event.text}\x1b[0m`);
        break;
    }
    actions.draw();
  };

  const result = await processMenuCommand(
    trimmed,
    session,
    ctx.workspacePath,
    agent.provider,
    {
      mcpRegistry: agent.mcpRegistry,
      onStatus: (message: string) => {
        actions.pushTranscript(`\x1b[2m${message}\x1b[0m`);
        actions.draw();
      },
      onLiveStatus,
      elicit: ctx.elicit,
    },
  );

  if (result.success) {
    // Echo the command (like a normal turn's "You:") so the response has a visible prompt —
    // UNLESS it delegates to handleInputTurn (autoExecute), which renders its own "You:".
    // (Normal non-command input never reaches here — it returns false below and handleInputTurn
    // echoes it, so this avoids the double-echo bug.)
    if (!result.autoExecute) {
      actions.pushTranscript(displayUserLabel(trimmed));
    }
    actions.pushTranscript(result.response);

    // Persist commands that asked to be recorded (e.g. /ask-document) into the session so the
    // Q&A is part of the conversation history — enabling follow-ups and recall, and not lost.
    if (result.recordInSession && !result.newSession) {
      session.messages.push({ role: "user", content: trimmed });
      session.messages.push({ role: "assistant", content: result.response });
      // The history just grew, so the sticky gauge must too — it is only republished at the end of
      // a real turn, and would otherwise keep the pre-command figure until the next message.
      addContextReading(state, trimmed, result.response);
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

    // Refresh the sticky context bar after any session-mutating command:
    // /mode, /model, /role, /provider, /clear, /runplan — all of these
    // change the active model or history, so the bar would otherwise stay
    // stale until the next real turn.
    refreshStickyReading(state, agent, session, ctx.workspacePath);

    // Handle automatic execution (e.g., /runplan) via the full streaming pipeline
    // so patch diffs and live output are shown correctly.
    if (result.autoExecute) {
      const { prompt } = result.autoExecute;
      await handleInputTurn(prompt, ctx, {
        displayText: autoExecuteLabel(prompt, trimmed),
      });
    }
    return true;
  }

  // A command that FAILED is still a command: surface its error rather than falling through to the
  // model, which would answer a question nobody asked.
  if (looksLikeCommand(trimmed)) {
    actions.pushTranscript(displayUserLabel(trimmed));
    actions.pushTranscript(result.response);
    return true;
  }

  return false;
}
