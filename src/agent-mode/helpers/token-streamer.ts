import type { ModelProvider } from "../../providers/model-provider.js";
import type { ChatMessage } from "../../chat/types.js";

/**
 * Streams response chunks from the model provider in real-time.
 * - type "thinking": content inside <think>...</think> blocks (show dim/italic live)
 * - type "text":     actual response prose outside think blocks (buffer, render at end)
 * - type "status":   action-block markers (<edit>, <create>, etc.)
 * Returns the full accumulated raw response string.
 */
export async function streamTurnWithInterception(params: {
  provider: ModelProvider;
  messages: ChatMessage[];
  model?: string;
  onChunk?: (event: { type: "thinking" | "text" | "status"; content: string }) => void;
}): Promise<string> {
  const { provider, messages, model, onChunk } = params;

  if (!provider.streamChat) {
    const fullResponse = await provider.completeChat(messages, { model });
    // Fallback: strip think wrapper (keep content) and action blocks, emit as text
    const prose = fullResponse
      .replace(/<think>([\s\S]*?)(<\/think>|$)/gi, "$1")
      .replace(/<(edit|create|request_files|execute_command|call_tool|wholefile)\b[\s\S]*?<\/\1>/gi, "")
      .trim();
    if (prose) {
      onChunk?.({ type: "text", content: prose });
    }
    return fullResponse;
  }

  let accumulated = "";
  let lastYieldedLength = 0;
  let openTag: string | null = null;   // currently inside an opaque intercept block
  let insideThink = false;             // currently inside a <think> block

  const TAG_START_REGEX = /<([a-z0-9_]+)\b[^>]*>/i;
  const INTERCEPT_TAGS = ["edit", "create", "wholefile", "request_files", "execute_command", "call_tool"];

  // Emit prose content, using the current insideThink state to pick the type.
  const emitProse = (content: string) => {
    if (content) onChunk?.({ type: insideThink ? "thinking" : "text", content });
  };

  const stream = provider.streamChat(messages, { model });
  for await (const token of stream) {
    accumulated += token;

    while (lastYieldedLength < accumulated.length) {
      const unyielded = accumulated.slice(lastYieldedLength);

      if (openTag === null) {
        const nextBracket = unyielded.indexOf("<");
        if (nextBracket === -1) {
          emitProse(unyielded);
          lastYieldedLength = accumulated.length;
        } else {
          if (nextBracket > 0) {
            emitProse(unyielded.slice(0, nextBracket));
            lastYieldedLength += nextBracket;
          }

          const bracketIndexInAccumulated = lastYieldedLength;
          const tagCloseBracket = accumulated.indexOf(">", bracketIndexInAccumulated);

          if (tagCloseBracket === -1) {
            break; // incomplete tag — wait for more tokens
          }

          const tagString = accumulated.slice(bracketIndexInAccumulated, tagCloseBracket + 1);
          const match = tagString.match(TAG_START_REGEX);

          if (match) {
            const tagName = match[1].toLowerCase();
            if (INTERCEPT_TAGS.includes(tagName)) {
              openTag = tagName;
              let statusMsg = "";
              if (tagName === "edit")          statusMsg = "\n\x1b[33m🛠️  [REI] Proposing Search & Replace edits...\x1b[0m\n";
              else if (tagName === "create")   statusMsg = "\n\x1b[33m📂  [REI] Creating new files...\x1b[0m\n";
              else if (tagName === "wholefile")statusMsg = "\n\x1b[33m📝  [REI] Rewriting workspace files...\x1b[0m\n";
              else if (tagName === "request_files")    statusMsg = "\n\x1b[33m🔍  [REI] Requesting additional codebase files...\x1b[0m\n";
              else if (tagName === "execute_command")  statusMsg = "\n\x1b[33m💻  [REI] Running project command...\x1b[0m\n";
              else if (tagName === "call_tool")        statusMsg = "\n\x1b[33m🔧  [REI] Invoking system tool...\x1b[0m\n";
              onChunk?.({ type: "status", content: statusMsg });
            } else if (tagName === "think") {
              insideThink = true; // enter think block — don't emit the <think> tag itself
            } else {
              emitProse(tagString); // unknown opening tag: emit as prose
            }
          } else {
            // Malformed or closing tag (e.g. </think>, </unknown>)
            if (/<\/think\s*>/i.test(tagString)) {
              insideThink = false; // exit think block — don't emit </think>
            } else {
              emitProse(tagString);
            }
          }
          lastYieldedLength = tagCloseBracket + 1;
        }
      } else {
        // Inside an opaque intercept block — skip everything until closing tag
        const closingTagString = `</${openTag}>`;
        const closingTagIndex = accumulated.indexOf(closingTagString, lastYieldedLength);
        if (closingTagIndex === -1) {
          break; // incomplete block — wait for more tokens
        }
        lastYieldedLength = closingTagIndex + closingTagString.length;
        openTag = null;
      }
    }
  }

  return accumulated;
}
