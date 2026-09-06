/**
 * @fileoverview IP-4 — `withTelemetry` provider decorator (Multi-Agent A2A + OTel plan).
 *
 * Wraps a `ModelProvider` so each model call emits an `llm-call` span and each model
 * load/unload emits a `model-swap` span (via Laminar's `observe`). Crucially it FORWARDS
 * every other method unchanged — including the optional `ModelLifecycle` methods
 * (`loadModel`/`unloadModel`/`isModelLoaded`). A naive decorator that shadowed those would
 * silently break model swapping (incompatibility C6); the Proxy here cannot, because it
 * only special-cases the LLM and swap methods and passes through everything else.
 *
 * Stays Laminar-direct: provider/model are recorded with Laminar's native gen_ai
 * attributes (`LaminarAttributes.PROVIDER`/`REQUEST_MODEL`) so they render in the LLM view.
 *
 * @module rei/providers/with-telemetry
 */

// TYPE-only (erased at compile time): the SDK calls `dotenv.config()` when imported, which would
// refill every env key load-env.ts deliberately leaves unset. It is fetched from the telemetry
// module instead, which loads it only when tracing is actually on.
import type * as Lmnr from "@lmnr-ai/lmnr";
import { SpanName } from "../contracts/execution-contract.js";
import type { ModelProvider } from "./model-provider.js";
import { getLaminarSdk, isTelemetryInitialized } from "../telemetry/init.js";

const LLM_METHODS = new Set([
  "complete",
  "completeChat",
  "completeChatWithTools",
  "streamChatWithTools",
  "streamChat",
]);
const SWAP_METHODS = new Set(["loadModel", "unloadModel"]);

/** Find the requested model from a call's args (the last object arg with a `model`). */
function extractModel(args: unknown[]): string | undefined {
  for (let i = args.length - 1; i >= 0; i -= 1) {
    const arg = args[i];
    if (arg && typeof arg === "object" && "model" in arg) {
      const model = (arg as { model?: unknown }).model;
      if (typeof model === "string" && model) return model;
    }
  }
  return undefined;
}

/**
 * Decorate a `ModelProvider` with `llm-call` / `model-swap` spans. `providerName` labels
 * each span (e.g. "ollama", "openrouter"). All non-instrumented members forward unchanged.
 */
export function withTelemetry(
  provider: ModelProvider,
  providerName: string,
): ModelProvider {
  if (!isTelemetryInitialized()) return provider;
  const lmnr: typeof Lmnr | undefined = getLaminarSdk();
  // initialized implies loaded; the guard keeps this honest rather than asserting.
  if (!lmnr) return provider;
  const { observe, Laminar, LaminarAttributes } = lmnr;
  return new Proxy(provider, {
    get(target, prop, receiver) {
      const orig = Reflect.get(target, prop, receiver);
      if (typeof orig !== "function" || typeof prop !== "string") return orig;
      const fn = orig as (...args: unknown[]) => unknown;

      if (LLM_METHODS.has(prop)) {
        // Record the span INPUT as the messages/prompt only (the first arg of every LLM
        // method: `(messages, tools?, opts?)`). An `LLM`-typed span renders its input as a
        // chat conversation, so feeding it the raw positional arg list `[messages, tools,
        // opts]` makes Laminar mis-read it as a 3-message array and hide the real messages.
        // The model is recorded as an attribute; tools/opts are config, not the prompt.
        const setLlmAttrs = (args: unknown[]) => {
          const attrs: Record<string, string> = {
            [LaminarAttributes.PROVIDER]: providerName,
          };
          const model = extractModel(args);
          if (model) attrs[LaminarAttributes.REQUEST_MODEL] = model;
          Laminar.setSpanAttributes(attrs);
        };

        // `streamChat` returns an async generator. A plain `observe` would close the span the
        // instant the generator is *returned* — before the model HTTP request fires during
        // consumption — so the streamed text wouldn't be captured and the request's
        // auto-instrumented span would detach (surfacing un-nested). Instead keep a
        // global-active span open across iteration (like `withTurnSpanStream` does for the
        // Turn): the request span nests under it and the accumulated text becomes the output.
        if (prop === "streamChat") {
          return (...args: unknown[]): AsyncIterable<string> => {
            async function* traced(): AsyncIterable<string> {
              const span = Laminar.startActiveSpan({
                name: SpanName.llmCall,
                spanType: "LLM",
                input: args[0],
                global: true,
              });
              setLlmAttrs(args);
              const chunks: string[] = [];
              try {
                for await (const chunk of fn.apply(
                  target,
                  args,
                ) as AsyncIterable<string>) {
                  chunks.push(chunk);
                  yield chunk;
                }
              } finally {
                Laminar.setSpanOutput(chunks.join(""));
                span.end();
              }
            }
            return traced();
          };
        }

        return (...args: unknown[]) =>
          observe(
            { name: SpanName.llmCall, spanType: "LLM", input: args[0] },
            () => {
              setLlmAttrs(args);
              return fn.apply(target, args);
            },
          );
      }

      if (SWAP_METHODS.has(prop)) {
        return (model: string) =>
          observe(
            { name: SpanName.modelSwap, input: { op: prop, model } },
            () => fn.call(target, model),
          );
      }

      // isModelLoaded (a poll, not a swap) + any other method: forward unchanged.
      return fn.bind(target);
    },
  });
}
