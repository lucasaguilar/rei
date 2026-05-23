import type { TurnStatus } from "../../core/models/agent.types.js";
import { renderMarkdown } from "../markdown-renderer.js";
import type { InputHandlerContext } from "../models/input-handler.types.js";
import { saveSession } from "../../chat/session-store.js";
import { extractSREdits } from "../../agent-mode/response-handler.js";
import { formatCodeDiff } from "../markdown-renderer.js";

function resolveActiveModelLabel(mode?: string): string {
  const isAgentMode = mode === "agent";
  const agentProvider = process.env.AGENT_MODEL_PROVIDER?.trim().toLowerCase();
  
  const provider = (isAgentMode && agentProvider)
    ? agentProvider
    : (process.env.MODEL_PROVIDER ?? "").trim().toLowerCase();

  const getModelName = (prov: string): string => {
    switch (prov) {
      case "ollama":
        if (isAgentMode) {
          return process.env.OLLAMA_MODEL_AGENT?.trim() || process.env.OLLAMA_MODEL?.trim() || "default";
        }
        const modeKey = mode ? `OLLAMA_MODEL_${mode.toUpperCase()}` : undefined;
        const modeSpecific = modeKey ? process.env[modeKey]?.trim() : undefined;
        return (modeSpecific ?? process.env.OLLAMA_MODEL?.trim()) || "default";
      case "openrouter":
        return (isAgentMode ? process.env.OPENROUTER_MODEL_AGENT : undefined)?.trim() || process.env.OPENROUTER_MODEL?.trim() || "default";
      case "groq":
        return (isAgentMode ? process.env.GROQ_MODEL_AGENT : undefined)?.trim() || process.env.GROQ_MODEL?.trim() || "default";
      case "gemini":
        return (isAgentMode ? process.env.GEMINI_MODEL_AGENT : undefined)?.trim() || process.env.GEMINI_MODEL?.trim() || "default";
      case "huggingface":
        return (isAgentMode ? process.env.HF_MODEL_AGENT : undefined)?.trim() || process.env.HF_MODEL?.trim() || "default";
      case "llmstudio":
        return (isAgentMode ? process.env.LLM_STUDIO_MODEL_AGENT : undefined)?.trim() || process.env.LLM_STUDIO_MODEL?.trim() || "default";
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

  state.busy = true;
  state.activeStatus = "building_context";
  state.spinnerIndex = 0;
  actions.startSpinner();
  actions.draw();

  try {
    let lastStatus: TurnStatus | undefined;
    let buffer = "";
    let liveStart = -1;
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

        // Force immediate UI refresh so short phases still become visible.
        actions.draw();

        if (status === "calling_model" && callingModelTime < 0) {
          callingModelTime = Date.now();
        }
      },
    })) {
      if (firstTokenTime < 0 && token.trim()) {
        firstTokenTime = Date.now();
        if (liveStart < 0) {
          // Stop spinner REDRAWS to prevent interleaving with streaming output,
          // but keep state.busy = true so input stays blocked until stream ends.
          actions.stopSpinner();
          state.activeStatus = undefined;
          liveStart = 1;
          actions.streamText(`\x1b[1;32mREI: \x1b[0m`);
        }
      }
      chunkCount++;
      buffer += token;
      if (liveStart > 0) {
        actions.streamText(token);
      }
    }

    const endTime = Date.now();

    // Procesar el buffer final: extraer edits y formatear
    const edits = extractSREdits(buffer);
    let finalContent = buffer;

    if (edits.length > 0) {
      // Limpiar el buffer de los tags XML para el renderizado markdown
      finalContent = buffer.replace(/<edit[\s\S]*?<\/edit>/gi, "").trim();
    }

    if (liveStart > 0) {
      actions.streamText("\n");
      actions.pushTranscript(`\x1b[1;32mREI: \x1b[0m${renderMarkdown(finalContent)}`, false);
    }

    if (liveStart < 0) {
      actions.pushTranscript("");
      actions.pushTranscript(`\x1b[1;36mYou: ${trimmed}\x1b[0m`);
      actions.pushTranscript("");
      actions.pushTranscript(`\x1b[1;32mREI: \x1b[0m${renderMarkdown(finalContent)}`);
    }

    // Si hubo edits, los añadimos formateados al final
    if (edits.length > 0) {
      actions.pushTranscript("\n### Cambios propuestos:");
      for (const edit of edits) {
        actions.pushTranscript(
          `\n**Archivo:** ${edit.file}\n${formatCodeDiff(edit.search, edit.replace)}`,
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

    const recTokens = Math.max(1, Math.round(buffer.length / 4));

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
