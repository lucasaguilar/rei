import type { TurnStatus } from "../../core/models/agent.types.js";
import { renderMarkdown } from "../markdown-renderer.js";
import type { InputHandlerContext } from "../models/input-handler.types.js";
import { saveSession } from "../../chat/session-store.js";
import { extractSREdits } from "../../agent-mode/response-handler.js";
import { formatCodeDiff } from "../markdown-renderer.js";
import { estimateMessagesTokens } from "../../chat/helpers/token-estimator.js";

/**
 * Resolves the active model label and maps it to its corresponding brand icon or emoji
 * (e.g. 🦙 for Ollama, 🧠 for OpenRouter, ⚡ for Groq, ♊ for Gemini, 💻 for LM Studio).
 * Supports dedicated agent provider resolution in multi-provider environments.
 */
function resolveActiveModelLabel(mode?: string): string {
  const isAgentMode = mode === "agent";
  const agentProvider = process.env.AGENT_MODEL_PROVIDER?.trim().toLowerCase();

  const provider =
    isAgentMode && agentProvider
      ? agentProvider
      : (process.env.MODEL_PROVIDER ?? "").trim().toLowerCase();

  const getModelName = (prov: string): string => {
    switch (prov) {
      case "ollama":
        if (isAgentMode) {
          return (
            process.env.OLLAMA_MODEL_AGENT?.trim() ||
            process.env.OLLAMA_MODEL?.trim() ||
            "default"
          );
        }
        const modeKey = mode ? `OLLAMA_MODEL_${mode.toUpperCase()}` : undefined;
        const modeSpecific = modeKey ? process.env[modeKey]?.trim() : undefined;
        return (modeSpecific ?? process.env.OLLAMA_MODEL?.trim()) || "default";
      case "openrouter":
        return (
          (isAgentMode
            ? process.env.OPENROUTER_MODEL_AGENT
            : undefined
          )?.trim() ||
          process.env.OPENROUTER_MODEL?.trim() ||
          "default"
        );
      case "groq":
        return (
          (isAgentMode ? process.env.GROQ_MODEL_AGENT : undefined)?.trim() ||
          process.env.GROQ_MODEL?.trim() ||
          "default"
        );
      case "gemini":
        return (
          (isAgentMode ? process.env.GEMINI_MODEL_AGENT : undefined)?.trim() ||
          process.env.GEMINI_MODEL?.trim() ||
          "default"
        );
      case "huggingface":
        return (
          (isAgentMode ? process.env.HF_MODEL_AGENT : undefined)?.trim() ||
          process.env.HF_MODEL?.trim() ||
          "default"
        );
      case "llmstudio":
        return (
          (isAgentMode
            ? process.env.LLM_STUDIO_MODEL_AGENT
            : undefined
          )?.trim() ||
          process.env.LLM_STUDIO_MODEL?.trim() ||
          "default"
        );
      default:
        return "default";
    }
  };

  const modelName = getModelName(provider);

  if (provider === "ollama") {
    return `🦙 ${modelName}`;
  }
  if (provider === "openrouter") {
    return `🧠 ${modelName}`;
  }
  if (provider === "groq") {
    return `⚡ ${modelName}`;
  }
  if (provider === "gemini") {
    return `♊ ${modelName}`;
  }
  if (provider === "huggingface") {
    return `🤗 ${modelName}`;
  }
  if (provider === "llmstudio") {
    return `💻 ${modelName}`;
  }
  if (provider === "mock") {
    return `🧪 ${modelName}`;
  }

  if (provider) {
    return `${provider}(${modelName})`;
  }

  return "unknown";
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
): Promise<void> {
  const { state, agent, session, transcript, actions } = ctx;

  // Show user input immediately
  actions.pushTranscript("");
  actions.pushTranscript(`\x1b[1;36mYou: ${trimmed}\x1b[0m`);
  actions.pushTranscript("");
  actions.draw();

  const estimatedTokens = estimateMessagesTokens(session.messages);
  if (estimatedTokens > 20000) {
    actions.pushTranscript(
      `\x1b[33m⚠️  [REI] Warning: The accumulated session exceeds 20,000 tokens (approximately ${estimatedTokens} tokens). ` +
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
    // total output chars including thinking (for tok/s metrics)
    let totalOutputChars = 0;
    // track whether any thinking or status content was shown live
    let liveContentShown = false;
    let firstTokenTime = -1;
    let callingModelTime = -1;
    let chunkCount = 0;
    const startTime = Date.now();

    for await (const token of agent.streamTurn(session, trimmed, {
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

      chunkCount++;
      totalOutputChars += cleanToken.length;

      // Track first visible token for timing
      if (firstTokenTime < 0 && cleanToken.trim()) {
        firstTokenTime = Date.now();
      }

      if (isThinking) {
        // Skip whitespace-only thinking tokens (model emits \n at init, creates blank lines)
        if (!cleanToken.trim()) continue;
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

        if (!isText && !isNowInside && !wasInside && cleanToken.trim()) {
          // status / agent raw response: show live — skip whitespace-only tokens
          if (!liveContentShown) {
            actions.stopSpinner();
            state.activeStatus = undefined;
            liveContentShown = true;
          }
          actions.streamText(cleanToken);
        }
        // \x11 text tokens: silently buffered, rendered as markdown after stream ends
      }
    }

    const endTime = Date.now();

    // Strip ANSI codes and XML action tags to get clean markdown for rendering
    const edits = extractSREdits(buffer);
    const finalContent = buffer
      .replace(/\x1b\[[0-9;]*m/g, "") // strip ANSI (e.g. from patch result)
      .replace(/<think>[\s\S]*?<\/think>/gi, "") // safety strip
      .replace(/<edit[\s\S]*?<\/edit>/gi, "")
      .replace(/<wholefile[\s\S]*?<\/wholefile>/gi, "")
      .replace(/<create[\s\S]*?<\/create>/gi, "")
      .replace(/<request_files[\s\S]*?<\/request_files>/gi, "")
      .replace(/<execute_command[\s\S]*?<\/execute_command>/gi, "")
      .replace(/<call_tool[\s\S]*?<\/call_tool>/gi, "")
      .trim();

    // One newline separator after live thinking/status content, only when there's a rendered response to follow
    const rendered = renderMarkdown(finalContent);
    if (rendered.trim()) {
      if (liveContentShown) {
        actions.streamText("\n");
      }
      actions.pushTranscript(`\x1b[1;32mREI: \x1b[0m${rendered}`);
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
    const totalMs = Math.max(1, endTime - startTime);

    // Approximate token counts (1 token ~= 4 chars in mixed code/text prompts)
    const inputMsgs = session.messages.slice(0, -1);
    const inputChars = inputMsgs.reduce((acc, m) => acc + m.content.length, 0);
    const sentTokens = Math.round(inputChars / 4);

    const recTokens = Math.max(1, Math.round(totalOutputChars / 4));

    const streamSpeedValue = recTokens / (generationMs / 1000);
    const averageSpeedValue = recTokens / (totalMs / 1000);
    const formatSpeed = (value: number): string =>
      value > 0 && value < 0.1 ? "<0.1" : value.toFixed(1);
    const streamSpeed = formatSpeed(streamSpeedValue);
    const averageSpeed = formatSpeed(averageSpeedValue);
    const speedText =
      chunkCount > 1 ? `${streamSpeed} tok/s` : `${averageSpeed} tok/s (avg)`;

    const outputNote = recTokens <= 2 ? " | Note: very short output" : "";
    const activeModel = resolveActiveModelLabel(session.mode);

    actions.pushTranscript(
      `\n\x1b[90m⏱️ Prep: ${(prepMs / 1000).toFixed(2)}s | TTFT(model): ${(ttftMs / 1000).toFixed(2)}s | Speed: ${speedText} | Tokens: ~${sentTokens} tok in, ~${recTokens} tok out | Model: ${activeModel}${outputNote}\x1b[0m`,
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
