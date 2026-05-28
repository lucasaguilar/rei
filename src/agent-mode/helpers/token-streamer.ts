import type { ModelProvider } from "../../providers/model-provider.js";
import type { ChatMessage } from "../../chat/types.js";

/**
 * Streams response chunks from the model provider in real-time, yielding thoughts/prose
 * immediately while buffering and hiding raw XML action blocks.
 * Returns the full accumulated raw response string.
 */
export async function streamTurnWithInterception(params: {
  provider: ModelProvider;
  messages: ChatMessage[];
  model?: string;
  onChunk?: (event: { type: "thinking" | "status"; content: string }) => void;
}): Promise<string> {
  const { provider, messages, model, onChunk } = params;

  if (!provider.streamChat) {
    const fullResponse = await provider.completeChat(messages, { model });
    // Fallback: yield prose by stripping action tags
    const prose = fullResponse
      .replace(/<(edit|create|request_files|execute_command|call_tool|wholefile)\b[\s\S]*?<\/\1>/gi, "")
      .trim();
    if (prose) {
      onChunk?.({ type: "thinking", content: prose });
    }
    return fullResponse;
  }

  let accumulated = "";
  let lastYieldedLength = 0;
  let openTag: string | null = null;

  // Regex to detect tag boundaries
  const TAG_START_REGEX = /<([a-z0-9_]+)\b[^>]*>/i;
  const INTERCEPT_TAGS = ["edit", "create", "wholefile", "request_files", "execute_command", "call_tool"];

  const stream = provider.streamChat(messages, { model });
  for await (const token of stream) {
    accumulated += token;

    while (lastYieldedLength < accumulated.length) {
      const unyielded = accumulated.slice(lastYieldedLength);

      if (openTag === null) {
        // Look for the next '<' character
        const nextBracket = unyielded.indexOf("<");
        if (nextBracket === -1) {
          // No tag start found in unyielded suffix. Yield everything.
          onChunk?.({ type: "thinking", content: unyielded });
          lastYieldedLength = accumulated.length;
        } else {
          // Yield prose up to the '<'
          if (nextBracket > 0) {
            const prosePart = unyielded.slice(0, nextBracket);
            onChunk?.({ type: "thinking", content: prosePart });
            lastYieldedLength += nextBracket;
          }

          // Check if we have a complete tag opening
          const bracketIndexInAccumulated = lastYieldedLength;
          const tagCloseBracket = accumulated.indexOf(">", bracketIndexInAccumulated);

          if (tagCloseBracket === -1) {
            // Incomplete tag (e.g., "<ed" or "<edit"). Wait for more tokens.
            break;
          } else {
            // Complete tag opening found
            const tagString = accumulated.slice(bracketIndexInAccumulated, tagCloseBracket + 1);
            const match = tagString.match(TAG_START_REGEX);
            if (match) {
              const tagName = match[1].toLowerCase();
              if (INTERCEPT_TAGS.includes(tagName)) {
                openTag = tagName;
                // Trigger a clean status update for the UI/user
                let statusMsg = "";
                if (tagName === "edit") statusMsg = "\n\x1b[33m🛠️  [REI] Proposing Search & Replace edits...\x1b[0m\n";
                else if (tagName === "create") statusMsg = "\n\x1b[33m📂  [REI] Creating new files...\x1b[0m\n";
                else if (tagName === "wholefile") statusMsg = "\n\x1b[33m📝  [REI] Rewriting workspace files...\x1b[0m\n";
                else if (tagName === "request_files") statusMsg = "\n\x1b[33m🔍  [REI] Requesting additional codebase files...\x1b[0m\n";
                else if (tagName === "execute_command") statusMsg = "\n\x1b[33m💻  [REI] Running project command...\x1b[0m\n";
                else if (tagName === "call_tool") statusMsg = "\n\x1b[33m🔧  [REI] Invoking system tool...\x1b[0m\n";

                onChunk?.({ type: "status", content: statusMsg });
              } else {
                // Not a tag we intercept, yield as prose
                onChunk?.({ type: "thinking", content: tagString });
              }
            } else {
              // Malformed tag, yield as prose
              onChunk?.({ type: "thinking", content: tagString });
            }
            lastYieldedLength = tagCloseBracket + 1;
          }
        }
      } else {
        // We are inside an intercepted tag block. Look for the closing tag.
        const closingTagString = `</${openTag}>`;
        const closingTagIndex = accumulated.indexOf(closingTagString, lastYieldedLength);

        if (closingTagIndex === -1) {
          // Incomplete block. Wait for more tokens.
          break;
        } else {
          // Found the closing tag! Skip past it and resume prose mode
          lastYieldedLength = closingTagIndex + closingTagString.length;
          openTag = null;
        }
      }
    }
  }

  return accumulated;
}
