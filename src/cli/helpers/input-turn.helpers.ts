import * as path from "path";
import type { TurnStatus } from "../../core/models/agent.types.js";
import { renderMarkdown } from "../markdown-renderer.js";
import type { InputHandlerContext } from "../models/input-handler.types.js";
import { saveSession } from "../../chat/session-store.js";
import { extractSREdits } from "../../agent-mode/response-handler.js";
import { formatCodeDiff, formatContextGauge } from "../markdown-renderer.js";
import { estimateMessagesTokens } from "../../chat/helpers/token-estimator.js";
import { getContextWindow } from "../../config/model-runtime.js";
import { stripNativeToolSyntax } from "../../core/helpers/turn-message.helpers.js";
import { describeAttachedImages } from "../../tools/vision-sidecar.js";
import { resolveModelForMode } from "../../providers/provider-factory.js";
import type { SessionMode } from "../../chat/types.js";
import { displayUserLabel } from "./chat.helpers.js";

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

/**
 * Resolves the active model label and maps it to its corresponding brand icon or emoji
 * (e.g. 🦙 for Ollama, 🧠 for OpenRouter, ⚡ for Groq, ♊ for Gemini, 💻 for LM Studio).
 * Supports dedicated agent provider resolution in multi-provider environments.
 */
export function resolveActiveModelLabel(mode?: string): string {
  const isAgentMode = mode === "agent";
  const agentProvider = process.env.AGENT_MODEL_PROVIDER?.trim().toLowerCase();

  const provider =
    isAgentMode && agentProvider
      ? agentProvider
      : (process.env.MODEL_PROVIDER ?? "").trim().toLowerCase();

  // Use the same resolver the agent uses so the label always matches the model that
  // actually runs (ask/planning → <PROVIDER>_MODEL, agent → <PROVIDER>_MODEL_AGENT).
  const modelName =
    resolveModelForMode((mode as SessionMode) ?? "ask") ?? "default";

  const emoji: Record<string, string> = {
    ollama: "🦙",
    openrouter: "🧠",
    groq: "⚡",
    gemini: "♊",
    huggingface: "🤗",
    llmstudio: "💻",
    mock: "🧪",
  };

  if (!provider) return "unknown";
  const icon = emoji[provider] ?? "";
  // Show provider / model so it's clear which backend AND model is active per mode.
  return `${icon ? icon + " " : ""}${provider} / ${modelName}`;
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
  state.activeStatus = "building_context";
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
        actions.pushTranscript(`\x1b[2m${message}\x1b[0m`);
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
        `\x1b[2m🖼️  ${parts.join(" + ")} analyzed; extracted text added to context.\x1b[0m`,
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
          `\x1b[2m📄 Documento activo: ${active} — preguntale con /ask-document <pregunta> (o /doc clear)\x1b[0m`,
        );
      }
      actions.pushTranscript("");
      actions.draw();
    }
  } catch (err) {
    actions.pushTranscript(
      `\x1b[33m⚠️  Vision sidecar error: ${err instanceof Error ? err.message : String(err)}\x1b[0m`,
    );
    actions.draw();
  }

  const estimatedTokens = estimateMessagesTokens(session.messages);
  const contextWindow = getContextWindow();
  const warningThreshold = Math.round(contextWindow * 0.75);
  if (estimatedTokens > warningThreshold) {
    actions.pushTranscript(
      `\x1b[33m⚠️  [REI] Warning: The accumulated session exceeds ${warningThreshold.toLocaleString()} tokens (approximately ${estimatedTokens.toLocaleString()} tokens). ` +
        `If you notice slowdowns or context-related errors, consider using /session new.\x1b[0m`,
    );
    actions.pushTranscript("");
  }

  state.busy = true;
  state.activeStatus = "building_context";
  state.spinnerIndex = 0;
  actions.startSpinner();
  actions.draw();

  try {
    let lastStatus: TurnStatus | undefined;
    // buffer accumulates non-thinking content (text + status/raw agent yields)
    let buffer = "";
    // Tracks raw feedback chunks (command output, tool results) that were already
    // shown live via streamText — excluded from the final markdown render to avoid duplication.
    let liveDisplayedFeedback = "";
    // total output chars including thinking (for tok/s metrics)
    let totalOutputChars = 0;
    // track whether any thinking or status content was shown live
    let liveContentShown = false;
    let firstTokenTime = -1;
    let callingModelTime = -1;
    const startTime = Date.now();

    for await (const token of agent.streamTurn(session, promptForModel, {
      elicit,
      onStatus: (status) => {
        if (lastStatus === status) return;
        if (status === "producing_response") return;

        lastStatus = status;
        state.activeStatus = status;
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
        if (!liveContentShown) {
          actions.stopSpinner();
          state.activeStatus = undefined;
          liveContentShown = true;
        }
        // Collapse 3+ consecutive newlines to 2 to avoid excessive blank lines in thinking
        const normalized = cleanToken.replace(/\n{3,}/g, "\n\n");
        actions.streamText(`\x1b[3;2m${normalized}\x1b[0m`);
      } else {
        // text (\x11) or raw status/agent-response token: accumulate in buffer
        const wasInside = isInsideXmlBlock(buffer);
        buffer += cleanToken;
        const isNowInside = isInsideXmlBlock(buffer);

        if (state.activeStatus && cleanToken.trim()) {
          actions.stopSpinner();
          state.activeStatus = undefined;
        }

        if (!isText && !isNowInside && !wasInside && cleanToken.trim()) {
          // status / agent raw response: show live — skip whitespace-only tokens
          if (!liveContentShown) {
            actions.stopSpinner();
            state.activeStatus = undefined;
            liveContentShown = true;
          }
          actions.streamText(cleanToken);
          // Track what was shown live so we can exclude it from the final markdown render
          liveDisplayedFeedback += cleanToken;
        }
        // \x11 text tokens: silently buffered, rendered as markdown after stream ends
      }
    }

    const endTime = Date.now();

    // Strip ANSI codes and XML action tags to get clean markdown for rendering.
    // Also remove any feedback that was already shown live (command output, tool results)
    // to prevent it from appearing twice on screen.
    const edits = extractSREdits(buffer);
    let cleanBuffer = buffer;
    if (liveDisplayedFeedback) {
      cleanBuffer = cleanBuffer.replace(liveDisplayedFeedback, "");
    }
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
      actions.pushTranscript(`\x1b[1;97;45m REI \x1b[0m ${rendered}`);
    }

    // Display formatted S&R diffs (ANSI diff, already styled by formatCodeDiff)
    if (edits.length > 0 && session.mode === "agent") {
      actions.pushTranscript(`\n\x1b[1;33mCambios propuestos:\x1b[0m`);
      for (const edit of edits) {
        actions.pushTranscript(
          `\x1b[1mArchivo:\x1b[0m ${edit.file}\n${formatCodeDiff(edit.search, edit.replace)}`,
        );
      }
    }

    if (firstTokenTime < 0) firstTokenTime = endTime;
    const prepMs =
      callingModelTime > 0 ? Math.max(0, callingModelTime - startTime) : 0;
    const ttftMs =
      callingModelTime > 0
        ? Math.max(0, firstTokenTime - callingModelTime)
        : Math.max(0, firstTokenTime - startTime);
    const generationMs = Math.max(1, endTime - firstTokenTime);

    // Approximate token counts (1 token ~= 4 chars in mixed code/text prompts)
    const inputMsgs = session.messages.slice(0, -1);
    const inputChars = inputMsgs.reduce((acc, m) => acc + m.content.length, 0);
    const historyTokens = Math.round(inputChars / 4);
    // The function-calling tools array (built-in + MCP schemas) is sent on every agent
    // request but is NOT in the message history — include it so the gauge reflects real
    // context usage. Large MCP servers can occupy a big share of the window invisibly.
    const toolsTokens = agent.estimateActiveToolsTokens(session.mode);
    const sentTokens = historyTokens + toolsTokens;

    const recTokens = Math.max(1, Math.round(totalOutputChars / 4));

    // Speed = decoded tokens (visible + thinking) / generation time.
    // `generationMs` is clamped to >= 1ms so single-chunk turns never produce Infinity.
    const speedValue = recTokens / (generationMs / 1000);
    const formatSpeed = (value: number): string =>
      value > 0 && value < 0.1 ? "<0.1" : value.toFixed(1);
    const speedText = `${formatSpeed(speedValue)} tok/s`;

    const activeModel = resolveActiveModelLabel(session.mode);

    // Visual context-usage gauge: how much of the assumed window the prompt consumed this turn.
    // Helps spot when history/files are about to overflow (and explains slow prefill).
    const gauge = formatContextGauge(
      sentTokens,
      getContextWindow(),
      activeModel,
    );
    if (gauge) actions.pushTranscript(`\n${gauge}`);

    actions.pushTranscript(
      `${gauge ? "" : "\n"}\x1b[90m⏱️  Prep: ${(prepMs / 1000).toFixed(2)}s | TTFT(model): ${(ttftMs / 1000).toFixed(2)}s | Speed: ${speedText} | Tokens: ~${sentTokens} tok in, ~${recTokens} tok out\x1b[0m`,
    );
    actions.pushTranscript("");
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

    actions.draw();
  }
}
