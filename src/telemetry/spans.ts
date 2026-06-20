/**
 * @fileoverview Manual span helpers over Laminar (Multi-Agent A2A + OTel plan, IP-2/IP-3).
 * Span names come from the canonical `SpanName` taxonomy in the execution contract so the
 * unified Laminar trace nests consistently (Turn → Step → tool/llm-call).
 *
 * Turn spans use `Laminar.startActiveSpan({ global: true })` rather than `observe`. A Turn
 * is a streaming async generator whose body runs on the *consumer's* stack (outside the
 * span's creation context), so an `observe`-wrapped Turn cannot parent the child spans
 * created while the model streams — they'd surface as separate root traces. The `global`
 * flag registers the Turn on a process-global context stack, so every `observe` call during
 * the Turn (llm-call, tool, step) nests under it until `span.end()`.
 *
 * This relies on rei's single-Turn-at-a-time invariant (one execution lock / serialized
 * serving, ADR 0001/0002): a process-global active span is correct only because Turns do
 * not overlap within a process.
 *
 * @module rei/telemetry/spans
 */

import { observe, Laminar } from "@lmnr-ai/lmnr";
import { SpanName } from "../contracts/execution-contract.js";
import { isTelemetryInitialized } from "./init.js";

/** Root span for one non-streaming Turn — `rei.turn`. `input` is the user prompt. */
export async function withTurnSpan<T>(
  input: string,
  fn: () => Promise<T>,
): Promise<T> {
  if (!isTelemetryInitialized()) return fn();
  const span = Laminar.startActiveSpan({
    name: SpanName.turn,
    input,
    global: true,
  });
  try {
    const result = await fn();
    Laminar.setSpanOutput(result);
    return result;
  } finally {
    span.end();
  }
}

/**
 * Root span for one streaming Turn — `rei.turn`. The span stays open until the caller
 * finishes iterating; tokens pass through unchanged and are accumulated as span output.
 * `input` is the user prompt.
 */
export async function* withTurnSpanStream(
  input: string,
  fn: () => AsyncIterable<string>,
): AsyncIterable<string> {
  if (!isTelemetryInitialized()) {
    yield* fn();
    return;
  }
  const span = Laminar.startActiveSpan({
    name: SpanName.turn,
    input,
    global: true,
  });
  const chunks: string[] = [];
  try {
    for await (const chunk of fn()) {
      chunks.push(chunk);
      yield chunk;
    }
  } finally {
    Laminar.setSpanOutput(chunks.join(""));
    span.end();
  }
}

/** Per-loop-iteration Step span — `step-N`. Nests under the active Turn. */
export const withStepSpan = <T>(n: number, fn: () => Promise<T>): Promise<T> =>
  isTelemetryInitialized()
    ? observe({ name: `${SpanName.step}-${n}` }, fn)
    : fn();

/**
 * Open a Step span (`step-N`) for one iteration of a *streaming* loop, whose body yields
 * to the consumer and so can't be wrapped by `withStepSpan`/`observe`. Global-active (like
 * the Turn) so the `llm-call`/`tool` spans created while the iteration streams nest under it
 * across generator yields. Returns an `end` thunk the caller MUST invoke (in `finally`).
 */
export function startStepSpan(n: number): () => void {
  if (!isTelemetryInitialized()) return () => {};
  const span = Laminar.startActiveSpan({
    name: `${SpanName.step}-${n}`,
    global: true,
  });
  return () => span.end();
}

/**
 * Tool-dispatch span — `tool.<name>`, Laminar `spanType: "TOOL"` (mirrors the `llm-call`
 * span's `"LLM"` type). `input` carries the tool's arguments; Laminar captures `fn`'s return
 * value as the span output. Nests under the active Turn/Step via the process-global stack.
 */
export const withToolSpan = <T>(
  name: string,
  input: Record<string, unknown>,
  fn: () => Promise<T>,
): Promise<T> =>
  isTelemetryInitialized()
    ? observe({ name: `${SpanName.tool}.${name}`, spanType: "TOOL", input }, fn)
    : fn();

/**
 * Open a tool span (`tool.<name>`, `spanType: "TOOL"`) for code that mutates state across the
 * call (so it can't be expressed as a single `withToolSpan` thunk). Global-active so it nests
 * under the current Step/Turn. Returns an `end` thunk the caller MUST invoke (in `finally`).
 */
export function startToolSpan(
  name: string,
  input: Record<string, unknown>,
): () => void {
  if (!isTelemetryInitialized()) return () => {};
  const span = Laminar.startActiveSpan({
    name: `${SpanName.tool}.${name}`,
    spanType: "TOOL",
    input,
    global: true,
  });
  return () => span.end();
}
