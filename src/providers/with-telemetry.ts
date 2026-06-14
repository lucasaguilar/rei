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

import { observe, Laminar, LaminarAttributes } from "@lmnr-ai/lmnr";
import { SpanName } from "../contracts/execution-contract.js";
import type { ModelProvider } from "./model-provider.js";

const LLM_METHODS = new Set([
  "complete",
  "completeChat",
  "completeChatWithTools",
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
  return new Proxy(provider, {
    get(target, prop, receiver) {
      const orig = Reflect.get(target, prop, receiver);
      if (typeof orig !== "function" || typeof prop !== "string") return orig;
      const fn = orig as (...args: unknown[]) => unknown;

      if (LLM_METHODS.has(prop)) {
        return (...args: unknown[]) =>
          observe({ name: SpanName.llmCall, spanType: "LLM" }, () => {
            const attrs: Record<string, string> = {
              [LaminarAttributes.PROVIDER]: providerName,
            };
            const model = extractModel(args);
            if (model) attrs[LaminarAttributes.REQUEST_MODEL] = model;
            Laminar.setSpanAttributes(attrs);
            return fn.apply(target, args);
          });
      }

      if (SWAP_METHODS.has(prop)) {
        return (model: string) =>
          observe({ name: SpanName.modelSwap, input: { op: prop, model } }, () =>
            fn.call(target, model),
          );
      }

      // isModelLoaded (a poll, not a swap) + any other method: forward unchanged.
      return fn.bind(target);
    },
  });
}
