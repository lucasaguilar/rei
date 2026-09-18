import { isDegenerate, looksLooping } from "../agent-mode/helpers/loop-guard.js";
import type { ModelProvider, CompletionOptions } from "./model-provider.js";
import type { ChatMessage } from "../chat/types.js";

/** How often (in characters) to check for degenerate output while streaming. */
const CHECK_INTERVAL = 100;

/**
 * Wraps a ModelProvider with degenerate response detection that can abort
 * early during streaming, preventing wasteful loops at the plan‑execution
 * and ask‑mode levels.
 *
 * Works with any provider:
 *  - If the provider supports `streamChat`, it intercepts the stream and
 *    checks `isDegenerate` every ~CHECK_INTERVAL characters. When a loop is
 *    detected it stops yielding tokens and returns what it has so far.
 *  - If the provider does NOT support streaming, it falls through to the
 *    original `completeChat` and only checks after the full response arrives
 *    (no early abort, but still caught before the command/tool loop runs).
 */
export function withDegenerateGuard(provider: ModelProvider): ModelProvider {
  const wrapped: ModelProvider = {
    ...provider,

    // Explicitly delegate prototype methods to prevent losing them during spread copy
    complete(prompt: string, options?: CompletionOptions): Promise<string> {
      return provider.complete(prompt, options);
    },

    async completeChat(
      messages: ChatMessage[],
      options?: CompletionOptions,
    ): Promise<string> {
      // When streaming is available, use it to detect loops early
      if (provider.streamChat) {
        let accumulated = "";
        let lastCheck = 0;

        for await (const token of provider.streamChat(messages, options)) {
          accumulated += token;
          // Check periodically to avoid excessive computation
          if (accumulated.length - lastCheck >= CHECK_INTERVAL) {
            lastCheck = accumulated.length;
            if (isDegenerate(accumulated)) {
              // Degenerate loop detected – return what we have so far
              options?.onFinish?.("stop");
              return accumulated;
            }
          }
        }
        return accumulated;
      }

      // Fallback: no streaming support – check after full response
      const response = await provider.completeChat(messages, options);
      if (isDegenerate(response)) {
        // Still return it; the caller (agent.ts / generator.ts) already
        // handles the degenerate case with user‑facing messages.
      }
      return response;
    },

    // Also wrap streamChat to catch callers that use it directly.
    streamChat: provider.streamChat
      ? async function* (
          messages: ChatMessage[],
          options?: CompletionOptions,
        ): AsyncIterable<string> {
          let accumulated = "";
          let lastCheck = 0;
          for await (const token of provider.streamChat!(messages, options)) {
            accumulated += token;
            if (accumulated.length - lastCheck >= CHECK_INTERVAL) {
              lastCheck = accumulated.length;
              if (isDegenerate(accumulated)) {
                // Stop yielding – break the loop
                return;
              }
            }
            yield token;
          }
        }
      : undefined,
  };

  // Conditionally delegate tool-calling capability if supported by the underlying provider
  if (provider.completeChatWithTools) {
    wrapped.completeChatWithTools = (messages, tools, options) => {
      return provider.completeChatWithTools!(messages, tools, options);
    };
  }
  // The streaming tools path — which, since the native unification, is EVERY agent turn.
  //
  // This used to be a bare delegation, and that made the guard dead code exactly where it was
  // needed most: a 27B cycling through the same two paragraphs ran to 12,000 output tokens in one
  // call, with nothing watching. The wrapper now reads the stream it is forwarding and answers
  // "stop" when the text starts repeating; the provider cancels the response body, so the backend
  // stops generating instead of finishing into the void.
  if (provider.streamChatWithTools) {
    wrapped.streamChatWithTools = (messages, tools, onDelta, options) => {
      let seen = "";
      let lastCheck = 0;
      let stopped = false;
      return provider.streamChatWithTools!(
        messages,
        tools,
        (delta) => {
          // Reasoning counts. The loop that prompted this lived entirely in the model's thinking,
          // where `content` stayed empty until the very end.
          seen += delta.content;
          const verdict = onDelta(delta);
          if (stopped) return "stop";
          if (seen.length - lastCheck >= CHECK_INTERVAL) {
            lastCheck = seen.length;
            if (looksLooping(seen)) {
              stopped = true;
              return "stop";
            }
          }
          return verdict;
        },
        options,
      );
    };
  }

  // Forward optional ModelLifecycle methods. The `{ ...provider }` spread above copies only
  // own-enumerable props, so prototype methods like loadModel/unloadModel/isModelLoaded would
  // otherwise be dropped here — silently breaking model swapping downstream (C6).
  for (const m of ["loadModel", "unloadModel", "isModelLoaded"] as const) {
    const fn = (provider as unknown as Record<string, unknown>)[m];
    if (typeof fn === "function") {
      (wrapped as unknown as Record<string, unknown>)[m] = (
        fn as (...args: unknown[]) => unknown
      ).bind(provider);
    }
  }

  return wrapped;
}