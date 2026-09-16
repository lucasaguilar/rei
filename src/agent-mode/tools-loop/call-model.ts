import type { ChatMessage } from "../../chat/types.js";
import type {
  ModelProvider,
  ToolDefinition,
  ChatCompletionWithTools,
} from "../../providers/model-provider.js";
import type { AgentLogger } from "../../core/logger.js";
import { preserveThinkingEnabled } from "../../config/model-runtime.js";

/**
 * One model call in the native agent loop: invokes the provider's tool-calling completion,
 * logs the request/response, and surfaces the model's reasoning live. Extracted from
 * executeAgentTurnWithTools (Phase 2). Truncation/continuation and tool-call processing are
 * handled by the caller — this is purely "ask the model, return its raw response".
 *
 * `provider.completeChatWithTools` is asserted to exist by the caller before the loop starts.
 */
/** Last serialized prompt, for the opt-in REI_PROMPT_TRACE diff. Module-level: one live turn. */
const promptTrace: { last?: string } = {};

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
  // reasoning — otherwise it's just noise (DEFAULT OFF; opt-in with REI_PRESERVE_THINKING=true).
  if (preserveThinkingEnabled()) {
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

  // Prefer the streaming tools path when the provider supports it: reasoning/text fragments surface
  // LIVE via onDelta instead of landing all at once when the turn ends. Same return shape, so the
  // rest of the loop is unchanged. (Spike — see docs/stream-tools-spike.md.) Text deltas are NOT
  // forwarded: the loop builds the final response (recap/created-files) which the caller displays —
  // forwarding text here would suppress that.
  // Opt-in prompt trace (REI_PROMPT_TRACE=1): logs how much of THIS prompt is a byte-exact prefix
  // of the previous one. A local backend reuses its KV cache only while each prompt extends the
  // last, so "common: 100%" means the call prefills just the new tokens and anything less means it
  // re-reads from the first differing byte. Cheap string work, off by default.
  if (process.env.REI_PROMPT_TRACE === "1") {
    const serialized = messages.map((m) => `${m.role}|${m.content ?? ""}`).join("\u0002");
    const prev = promptTrace.last;
    let common = 0;
    if (prev) {
      const max = Math.min(prev.length, serialized.length);
      while (common < max && prev[common] === serialized[common]) common += 1;
    }
    // The question is NOT "how much overlaps" — a pure extension always overlaps less than 100% of
    // the NEW prompt simply because it is longer. What matters is whether the whole PREVIOUS prompt
    // survived: only then does the backend prefill just the new tokens.
    const extendsPrevious = prev ? common === prev.length : true;
    logger.logInfo("[trace] prompt prefix", {
      chars: serialized.length,
      previousChars: prev?.length ?? 0,
      commonWithPrevious: common,
      extendsPrevious,
      // Only meaningful when the prefix broke: which message REI rewrote or dropped.
      rewroteMessage: extendsPrevious
        ? -1
        : messages.findIndex((_m, i) => {
            const upto = messages
              .slice(0, i + 1)
              .map((x) => `${x.role}|${x.content ?? ""}`)
              .join("\u0002").length;
            return upto > common;
          }),
    });
    promptTrace.last = serialized;
  }

  const opts = { model: modelOverride, reasoningEffort };
  let result: ChatCompletionWithTools;
  let streamed = false;
  // Counts live fragments received — a high count over the turn is concrete proof the response
  // arrived token-by-token (vs one big chunk), which is otherwise hard to tell visually.
  let deltaCount = 0;
  const firstDeltaAt = { t: 0 };
  if (typeof provider.streamChatWithTools === "function") {
    try {
      result = await provider.streamChatWithTools(
        messages,
        tools,
        (d) => {
          deltaCount += 1;
          if (firstDeltaAt.t === 0) firstDeltaAt.t = Date.now();
          if (d.type === "reasoning") {
            onChunk?.({ type: "thinking", content: d.content });
          }
        },
        opts,
      );
      streamed = true;
    } catch (err) {
      // Runtime safety net: a streaming failure (server quirk, mid-stream drop) must not break the
      // turn — fall back to the proven non-streaming call so the agent keeps working.
      logger.logInfo("[tools] streaming failed — falling back to non-streaming", {
        error: err instanceof Error ? err.message : String(err),
      });
      result = await provider.completeChatWithTools!(messages, tools, opts);
    }
  } else {
    result = await provider.completeChatWithTools!(messages, tools, opts);
  }

  logger.logInfo("[tools] Response", {
    streamed,
    // deltaCount >> 1 proves token-by-token streaming; streamMs = span from first to last fragment.
    ...(streamed
      ? { deltaCount, streamMs: firstDeltaAt.t ? Date.now() - firstDeltaAt.t : 0 }
      : {}),
    finishReason: result.finishReason,
    toolCalls: result.toolCalls.map((tc) => tc.function.name),
    contentPreview: result.content.slice(0, 120),
    reasoningPreview: result.reasoning?.slice(0, 120),
    ...(result.usage ? { usage: result.usage } : {}),
  });

  // Surface the model's reasoning live. In tool-calling turns, qwen3.6 puts its narration in
  // `reasoning` while `content` is empty — without this it's invisible. When streamed, reasoning
  // already arrived via onDelta above, so don't double-emit it here.
  if (!streamed && result.reasoning?.trim()) {
    onChunk?.({ type: "thinking", content: result.reasoning.trim() + "\n" });
  }

  return result;
}
