import type { ChatMessage } from "../../chat/types.js";
import type {
  ModelProvider,
  ToolDefinition,
  ChatCompletionWithTools,
} from "../../providers/model-provider.js";
import type { AgentLogger } from "../../core/logger.js";

/**
 * One model call in the native agent loop: invokes the provider's tool-calling completion,
 * logs the request/response, and surfaces the model's reasoning live. Extracted from
 * executeAgentTurnWithTools (Phase 2). Truncation/continuation and tool-call processing are
 * handled by the caller — this is purely "ask the model, return its raw response".
 *
 * `provider.completeChatWithTools` is asserted to exist by the caller before the loop starts.
 */
export async function callModel(params: {
  provider: ModelProvider;
  messages: ChatMessage[];
  tools: ToolDefinition[];
  modelOverride?: string;
  reasoningEffort?: string;
  logger: AgentLogger;
  onChunk?: (event: { type: "thinking" | "text" | "status"; content: string }) => void;
}): Promise<ChatCompletionWithTools> {
  const { provider, messages, tools, modelOverride, reasoningEffort, logger, onChunk } = params;

  // Observability for preserve-thinking: only log when it's actually ON and re-feeding
  // reasoning — otherwise it's just noise (default is ON since v0.14).
  if (process.env.REI_PRESERVE_THINKING !== "false") {
    const reasoningCarried = messages.filter(
      (m) => m.role === "assistant" && m.reasoning_content,
    );
    logger.logInfo("[tools] preserve-thinking", {
      enabled: true,
      assistantMsgsWithReasoning: reasoningCarried.length,
      reasoningCharsResent: reasoningCarried.reduce(
        (n, m) => n + (m.reasoning_content?.length ?? 0),
        0,
      ),
    });
  }

  const result = await provider.completeChatWithTools!(messages, tools, {
    model: modelOverride,
    reasoningEffort,
  });

  logger.logInfo("[tools] Response", {
    finishReason: result.finishReason,
    toolCalls: result.toolCalls.map((tc) => tc.function.name),
    contentPreview: result.content.slice(0, 120),
    reasoningPreview: result.reasoning?.slice(0, 120),
  });

  // Surface the model's reasoning live. In tool-calling turns, qwen3.6 puts its narration in
  // `reasoning` while `content` is empty — without this it's invisible.
  if (result.reasoning?.trim()) {
    onChunk?.({ type: "thinking", content: result.reasoning.trim() + "\n" });
  }

  return result;
}
