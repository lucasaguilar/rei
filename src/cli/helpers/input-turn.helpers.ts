import * as path from "path";
import type { TurnStatus } from "../../core/models/agent.types.js";
import { renderMarkdown } from "../markdown-renderer.js";
import type { InputHandlerContext } from "../models/input-handler.types.js";
import { saveSession } from "../../chat/session-store.js";
import { extractSREdits } from "../../agent-mode/response-handler.js";
import { resolveActiveModelLabel } from "./model-label.helper.js";
// Re-exported: it lived here, and the status bar + its tests import it from this path.
export { resolveActiveModelLabel } from "./model-label.helper.js";
import { isReasoningShown, isVerboseOutput } from "../../config/output-verbosity.js";
import { code, paint } from "../theme/palette.js";
import {
  beginPhase,
  formatEdits,
  formatThinkingSummary,
} from "./turn-display.helpers.js";
import { reportTurnMetrics } from "./turn-metrics.helpers.js";
import { publishCompactedReading, sessionSizeWarning } from "./startup-gauge.helper.js";
import { getContextWindow } from "../../config/model-runtime.js";
import { stripNativeToolSyntax } from "../../core/helpers/turn-message.helpers.js";
import { describeAttachedImages } from "../../tools/vision-sidecar.js";
import { resolveModelForMode } from "../../providers/provider-factory.js";
import type { SessionMode } from "../../chat/types.js";
import { displayUserLabel } from "./chat.helpers.js";
import { appendThinkingTail } from "../constants/chat.constants.js";

/**
 * Strips ANSI codes OUTSIDE fenced code blocks, but PRESERVES them inside ``` fences.
 * Colored diffs are emitted as ANSI inside a ```diff fence; marked-terminal passes ANSI
 * through code blocks verbatim, so keeping it there is what makes the rendered diff show
 * red/green (while the rest of the message stays clean of stray escape codes).
 */
function stripAnsiKeepingFences(text: string): string {
  const ansi = /\x1b\[[0-9;]*m/g;
  // Odd-indexed segments are fenced blocks (kept); even are outside (ANSI stripped).
  return text
    .split(/(```[\s\S]*?```)/g)
    .map((seg, i) => (i % 2 === 1 ? seg : seg.replace(ansi, "")))
    .join("");
}

function isInsideXmlBlock(text: string): boolean {
  const tags = [
    "edit",
    "wholefile",
    "create",
    "request_files",
    "execute_command",
    "call_tool",
  ];
  for (const tag of tags) {
    const lastOpen = text.lastIndexOf(`<${tag}`);
    const lastClose = text.lastIndexOf(`</${tag}>`);
    if (lastOpen > lastClose) {
      return true;
    }
  }
  return false;
}

export async function handleInputTurn(
  trimmed: string,
  ctx: InputHandlerContext,
  options?: { displayText?: string },
): Promise<void> {
  const { state, agent, session, transcript, actions, elicit } = ctx;

  // Show user input immediately — use a short label when the actual prompt is internal/verbose
  const displayLabel = options?.displayText ?? trimmed;
  actions.pushTranscript("");
  actions.pushTranscript(displayUserLabel(displayLabel));
  actions.pushTranscript("");
  actions.draw();

  // Mark the turn busy BEFORE any async work (the vision sidecar below is a network call
  // that can take a while). submitInput() bails when state.busy is true, so setting it
  // synchronously here — before the first await — prevents a second prompt from starting
  // concurrently and interleaving turns. There is no command queue yet.
  state.busy = true;
  beginPhase(state, "building_context");
  state.spinnerIndex = 0;
  actions.startSpinner();
  actions.draw();

  // Vision sidecar: if the user attached image(s) (dragged/pasted a path), describe
  // them with a vision model in a separate call and inject the text into the prompt.
  // Keeps the pipeline string-based; only the description is persisted, never base64.
  let promptForModel = trimmed;
  try {
    const vision = await describeAttachedImages(
      trimmed,
      ctx.workspacePath,
      (message) => {
        actions.pushTranscript(paint("dim", message));
        actions.draw();
      },
    );
    if (vision) {
      promptForModel = vision.augmentedPrompt;
      const parts: string[] = [];
      if (vision.images.length > 0)
        parts.push(`${vision.images.length} image(s)`);
      if (vision.documents.length > 0)
        parts.push(`${vision.documents.length} PDF(s)`);
      actions.pushTranscript(
        paint("dim", `🖼️  ${parts.join(" + ")} analyzed; extracted text added to context.`),
      );
      // Auto-activate the freshly-saved OCR doc as the /ask-document target (last one wins), so the
      // user can ask grounded questions without re-typing the path. Store it workspace-relative.
      const savedDoc = [...vision.documents].reverse().find((d) => d.savedPath);
      if (savedDoc?.savedPath) {
        const rel = path.relative(ctx.workspacePath, savedDoc.savedPath);
        const active = !rel || rel.startsWith("..") ? savedDoc.savedPath : rel;
        session.activeDocument = active;
        state.activeDocument = active;
        actions.pushTranscript(
          paint(
            "dim",
            `📄 Active document: ${active} — ask it with /ask-document <question> (or /doc clear)`,
          ),
        );
      }
      actions.pushTranscript("");
      actions.draw();
    }
  } catch (err) {
    actions.pushTranscript(
      paint("warn", `⚠️  Vision sidecar error: ${err instanceof Error ? err.message : String(err)}`),
    );
    actions.draw();
  }

  const sizeWarning = sessionSizeWarning(session);
  if (sizeWarning) {
    actions.pushTranscript(sizeWarning);
    actions.pushTranscript("");
  }

  state.busy = true;
  beginPhase(state, "building_context");
  state.spinnerIndex = 0;
  actions.startSpinner();
  actions.draw();

  try {
    let lastStatus: TurnStatus | undefined;
    // buffer accumulates non-thinking content (text + status/raw agent yields)
    let buffer = "";
    // Accumulates ONLY what was not already shown live, which is what the final markdown render
    // gets. Built by complement rather than by subtracting the live chunks afterwards: live and
    // buffered chunks interleave, so a concatenation of the live ones is not a contiguous substring
    // of `buffer` and the subtraction silently removed nothing — leaking command output (and its
    // diff, whose leading -/+ markdown reads as bullet markers) into the rendered answer.
    let renderBuffer = "";
    // total output chars including thinking (for tok/s metrics)
    let totalOutputChars = 0;
    // track whether any thinking or status content was shown live
    let liveContentShown = false;
    /** Whether the spinner is currently drawing. It is re-armed after every tool call, so "have we
     *  shown anything yet" is not the same question as "is it running right now". */
    let spinnerRunning = true;
    /** Reasoning characters seen while quiet — reported once instead of streamed. */
    let thinkingChars = 0;
    let firstTokenTime = -1;
    let callingModelTime = -1;
    const startTime = Date.now();

    for await (const token of agent.streamTurn(session, promptForModel, {
      elicit,
      // Hand over anything typed while this turn runs, and clear the queue: whatever is taken here
      // belongs to this turn. Anything typed after the last drain survives for the next one.
      drainUserMessages: () => state.queuedUserMessages?.splice(0) ?? [],
      onStatus: (status) => {
        // Not a phase: the history just SHRANK. Re-measure and republish now — the bar is showing a
        // figure taken before the compaction, and the end-of-turn reading that would correct it is
        // minutes away in an agent turn. Handled before the dedupe so two compactions in one turn
        // (auto at the start, the overflow retry later) both land.
        if (status === "memory_compacted") {
          publishCompactedReading(state, agent, session);
          // A line in the transcript, not just a refreshed bar: the bar is one number that moved,
          // which is easy to miss under a wall of tool output, and not seeing it is what got
          // /compact run by hand over an already-compacted session.
          actions.pushTranscript(
            paint("dim", "[REI] Memory compacted — older turns were summarized to free context."),
          );
          actions.draw();
          return;
        }

        if (lastStatus === status) return;
        if (status === "producing_response") return;

        lastStatus = status;
        beginPhase(state, status);
        state.busy = true;
        actions.draw();

        if (status === "calling_model" && callingModelTime < 0) {
          callingModelTime = Date.now();
        }
      },
    })) {
      // Decode type prefix: \x10 = thinking (show dim italic), \x11 = text (buffer silently)
      const isThinking = token.startsWith("\x10");
      const isText = token.startsWith("\x11");
      const cleanToken = isThinking || isText ? token.slice(1) : token;

      totalOutputChars += cleanToken.length;

      // Track first visible token for timing
      if (firstTokenTime < 0 && cleanToken.trim()) {
        firstTokenTime = Date.now();
      }

      if (isThinking) {
        // Skip whitespace-only thinking tokens ONLY at the start (model emits \n at
        // init, creating leading blank lines). Once content is flowing, preserve
        // whitespace so paragraph breaks in the reasoning render correctly.
        if (!liveContentShown && !cleanToken.trim()) continue;

        // With the reasoning stream off, the thinking is still COUNTED and reported as one line
        // per block, so its length stays visible without being readable. That is the right trade
        // on a model that thinks for most of the screen — but it is no longer the default, because
        // on a local model the thinking is also the only sign of life before the first tool call.
        if (!isReasoningShown()) {
          thinkingChars += cleanToken.length;
          continue; // the spinner keeps saying REI is working — see onStatus below
        }

        // DEFAULT: the reasoning rolls along the status line instead of being streamed.
        //
        // Streaming it free-hand costs the input prompt: every token calls streamText, which erases
        // the drawn block to write — so the prompt is gone for the whole think, and a keystroke
        // repaints it INTO the half-written sentence, whose row the next token then wipes. Exactly
        // when you want to type ("está sobrepensando, le corrijo") is when you were typing blind.
        // As drawn state it repaints with the block, the spinner keeps ticking, and the prompt
        // stays put. Verbose still dumps the whole stream — that is what verbose is for.
        if (!isVerboseOutput()) {
          thinkingChars += cleanToken.length;
          state.thinkingTail = appendThinkingTail(state.thinkingTail, cleanToken);
          continue; // the spinner's 100ms redraw carries it to the screen
        }

        // Stop the spinner EVERY time reasoning is about to stream, not just the first time in the
        // turn. It is re-armed after each tool call (see the `shownLive` branch below), so a guard
        // on `liveContentShown` — true from the first token onwards — left it running for every
        // later block: its status line redrew between fragments and the screen came out as
        // "thinking · 47s" interleaved into the middle of each sentence.
        if (spinnerRunning) {
          actions.stopSpinner();
          state.activeStatus = undefined;
          spinnerRunning = false;
        }
        liveContentShown = true;
        // Collapse 3+ consecutive newlines to 2 to avoid excessive blank lines in thinking
        const normalized = cleanToken.replace(/\n{3,}/g, "\n\n");
        actions.streamText(`${code("thinking")}${paint("dim", normalized)}`);
      } else {
        // text (\x11) or raw status/agent-response token: accumulate in buffer
        const wasInside = isInsideXmlBlock(buffer);
        buffer += cleanToken;
        const isNowInside = isInsideXmlBlock(buffer);

        if (state.activeStatus && cleanToken.trim()) {
          actions.stopSpinner();
          state.activeStatus = undefined;
          // The answer is arriving: the thinking that produced it is over, and its last half
          // sentence must not sit on screen next to the reply.
          state.thinkingTail = undefined;
        }

        const shownLive =
          !isText && !isNowInside && !wasInside && Boolean(cleanToken.trim());
        if (shownLive) {
          // status / agent raw response: show live — skip whitespace-only tokens
          if (spinnerRunning || !liveContentShown) {
            actions.stopSpinner();
            state.activeStatus = undefined;
            spinnerRunning = false;
            liveContentShown = true;
          }
          // Report the reasoning that ran before this tool call as ONE line. Quiet mode does not
          // print the reasoning itself, and silence about it would hide that most of the wait was
          // the model thinking rather than the tool running.
          if (thinkingChars > 0) {
            actions.streamText(formatThinkingSummary(thinkingChars));
            thinkingChars = 0;
          }
          actions.streamText(cleanToken);
          // Re-arm the spinner: the next stretch is the model working again, and without this the
          // screen went dead after the first tool call — the spinner stopped and never restarted,
          // so the only sign of life was the reasoning stream we just stopped printing.
          // The label describes what comes NEXT, and after a tool that is the model reasoning
          // again — not a fresh "calling model" announcement each of the twenty times.
          beginPhase(state, "calling_model");
          actions.startSpinner();
          spinnerRunning = true;
          actions.draw();
        } else {
          renderBuffer += cleanToken;
        }
        // \x11 text tokens: silently buffered, rendered as markdown after stream ends
      }
    }

    const endTime = Date.now();

    // Strip ANSI codes and XML action tags to get clean markdown for rendering.
    // Also remove any feedback that was already shown live (command output, tool results)
    // to prevent it from appearing twice on screen.
    const edits = extractSREdits(buffer);
    const cleanBuffer = renderBuffer;
    const finalContent = stripNativeToolSyntax(
      stripAnsiKeepingFences(cleanBuffer) // strip ANSI except inside ``` fences (colored diffs)
        .replace(/<think>[\s\S]*?<\/think>/gi, "") // safety strip
        .replace(/<edit[\s\S]*?<\/edit>/gi, "")
        .replace(/<wholefile[\s\S]*?<\/wholefile>/gi, "")
        .replace(/<create[\s\S]*?<\/create>/gi, "")
        .replace(/<request_files[\s\S]*?<\/request_files>/gi, "")
        .replace(/<execute_command[\s\S]*?<\/execute_command>/gi, "")
        .replace(/<call_tool[\s\S]*?<\/call_tool>/gi, ""),
    ).trim();

    // One newline separator after live thinking/status content, only when there's a rendered response to follow
    const rendered = renderMarkdown(finalContent);
    if (rendered.trim()) {
      if (liveContentShown) {
        actions.streamText("\n");
      }
      // Distinct badge so the user instantly spots REI's actual answer (vs thinking/status/
      // diffs). White-bold on magenta background — visually unmistakable.
      actions.pushTranscript(`${paint("badge", " REI ")} ${rendered}`);
    }

    // Display formatted S&R diffs (ANSI diff, already styled by formatCodeDiff)
    for (const line of session.mode === "agent" ? formatEdits(edits) : []) {
      actions.pushTranscript(line);
    }

    reportTurnMetrics({
      state,
      session,
      agent,
      pushTranscript: actions.pushTranscript,
      totalOutputChars,
      timings: { firstTokenTime, endTime, callingModelTime, startTime },
    });
  } catch (err: unknown) {
    actions.pushTranscript(
      `Error: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    state.busy = false;
    state.activeStatus = undefined;
    state.thinkingTail = undefined;
    actions.stopSpinner();

    saveSession(
      ctx.workspacePath,
      session.messages,
      session.mode,
      session.summary,
      session.createdAt,
    );

    actions.draw();
  }
}
