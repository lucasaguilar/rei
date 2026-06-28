import type { ChatSession } from "../../chat/types.js";
import type { AgentLogger } from "../../core/logger.js";
import { cleanResponseForHistory } from "../../core/helpers/turn-message.helpers.js";
import {
  buildFileContextMessage,
  generateXmlToolCallId,
} from "./patch-helpers.js";

/**
 * Handles a `<request_files>` turn for the XML agent paths: serves the requested files back as a
 * `request_files` tool result and records the exchange in history (assistant tool_call + tool
 * message), so the caller just `continue`s the loop. Mutates `currentMessages` by push.
 *
 * Dedup is opt-in via `alreadyProvided` (path → exact block last served): when passed, a file whose
 * content is unchanged since last shown is pointed back to instead of re-dumped (it's still in
 * history — saves tokens). Omit it to always re-serve the full content. Extracted from generator.ts
 * (Phase 3); the two paths differed ONLY in whether they deduped.
 */
export async function injectRequestedFiles(params: {
  fileRequests: string[];
  rawResponse: string;
  workspacePath: string;
  currentMessages: ChatSession["messages"];
  logger: AgentLogger;
  alreadyProvided?: Map<string, string>;
}): Promise<void> {
  const {
    fileRequests,
    rawResponse,
    workspacePath,
    currentMessages,
    logger,
    alreadyProvided,
  } = params;

  logger.logInfo(`Agent requested files: ${fileRequests.join(", ")}`);

  let contextMessage: string;
  if (alreadyProvided) {
    // Dedup: if a file's content is unchanged since we last served it, point the model back to it
    // instead of re-dumping the whole thing (it's still in history).
    const parts: string[] = [];
    for (const f of fileRequests) {
      const block = (await buildFileContextMessage(workspacePath, [f])).trimStart();
      if (alreadyProvided.get(f) === block) {
        parts.push(
          `--- File: ${f} ---\n(unchanged since you last read it above — reuse that content; do not re-read)`,
        );
        continue;
      }
      alreadyProvided.set(f, block);
      parts.push(block);
    }
    contextMessage = "\n" + parts.join("\n\n");
  } else {
    contextMessage = await buildFileContextMessage(workspacePath, fileRequests);
  }

  const rfId = generateXmlToolCallId("request_files");
  currentMessages.push({
    role: "assistant",
    content: cleanResponseForHistory(rawResponse),
    tool_calls: [
      {
        id: rfId,
        type: "function",
        function: {
          name: "request_files",
          arguments: JSON.stringify({ files: fileRequests }),
        },
      },
    ],
  });
  currentMessages.push({
    role: "tool",
    tool_call_id: rfId,
    name: "request_files",
    content: contextMessage,
  });
}
