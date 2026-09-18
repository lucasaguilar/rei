# Spike: `streamChatWithTools` — streaming on the native tool-calling path

Status: **IMPLEMENTED (behind a runtime fallback) — pending live validation against LM Studio.**
Goal: prove that native function-calling can ALSO stream tokens live,
so ask/planning can move off the XML interception path onto the native engine without losing the
live-typing chat UX. If it works, it collapses 3 execution paths (XML stream in `agent.ts` +
`generator.ts` XML loop + `generator-tools.ts` native) toward **one native engine**.

## The problem this unblocks

Today the path is chosen by capability, not by intent:

| | `streamChat` (XML path: ask/planning) | `completeChatWithTools` (native: agent) |
|---|---|---|
| Tokens | stream live | **wait for the whole response** |
| Tools | emitted as TEXT (`<execute_command>`) → unreliable | structured, API-enforced → reliable |
| Args | model guesses | structured schema |
| Grounding | weak (narrates, confabulates) | strong (API forces tool→result cycle) |

ask/planning use the XML path **only because `completeChatWithTools` doesn't stream** (see
`agent.ts`: *"completeChatWithTools doesn't stream, so we must emit; XML generators do stream"*).
That non-streaming is an **implementation limit, not fundamental** — the OpenAI-compatible APIs REI
uses (LM Studio, Ollama, Groq, OpenRouter) all support `stream:true` WITH `tools`.

## Core design decision: streaming is ADDITIVE

`streamChatWithTools` returns the **same `ChatCompletionWithTools`** as the non-streaming version,
plus a live `onDelta` callback. Everything downstream of the model call (`dispatchToolCalls`,
`handleTextResponse`, `applyEditBatch`, the whole loop) is **unchanged** — it still consumes the
final assembled result. Only the UX (live deltas) is new.

```ts
// model-provider.ts — new optional method
export interface ToolStreamDelta {
  type: "text" | "reasoning";
  content: string; // incremental fragment
}

streamChatWithTools?(
  messages: ChatMessage[],
  tools: ToolDefinition[],
  onDelta: (d: ToolStreamDelta) => void,
  options?: CompletionOptions,
): Promise<ChatCompletionWithTools>; // SAME return type as completeChatWithTools
```

## The hard part: parsing streamed `tool_calls` (SSE)

With `stream:true`, the OpenAI-compatible API sends SSE chunks (`data: {...}`) whose
`choices[0].delta` carries fragments. Tool calls arrive **incrementally and must be accumulated by
`index`**:

```
delta.tool_calls = [{ index:0, id:"call_abc", type:"function", function:{ name:"read_files", arguments:"" } }]
delta.tool_calls = [{ index:0, function:{ arguments:"{\"paths\"" } }]
delta.tool_calls = [{ index:0, function:{ arguments:": [\"a.ts\"]}" } }]
```

- `id` + `function.name` arrive in the FIRST delta for an `index`.
- `function.arguments` stream as fragments → **concatenate per index** into a buffer.
- A second tool call uses `index:1`, etc.
- `delta.content` → text fragment → `onDelta({type:"text"})` + append to content buffer.
- `delta.reasoning_content` / `delta.reasoning` → reasoning fragment → `onDelta({type:"reasoning"})`
  + append to reasoning buffer. (qwen3.6 puts narration here while content is empty.)
- `choices[0].finish_reason` → capture when present.
- On `data: [DONE]`: assemble `{ content, reasoning, toolCalls: parse each index buffer, finishReason }`.

JSON args are **only parsed at the end** (a mid-stream buffer is invalid JSON) — the accumulator
sidesteps the partial-JSON problem entirely.

## Where the code goes (minimal, contained)

1. **`providers/openai-tool-caller.ts`** — add `openaiStreamChatWithTools(params, onDelta)`:
   same request body as `openaiCompleteChatWithTools` but `stream:true`, plus an SSE reader +
   the per-index accumulator above. Reuses `toApiMessage`, `resolveAgentSampling`, `maxTokens`,
   headers — identical request shape, only `stream` flips and the response is read as a stream.
2. **`providers/lm-studio-provider.ts`** — add `streamChatWithTools` delegating to the shared core
   (one method, like the existing `completeChatWithTools`). **LM Studio only for the spike.**
3. **`agent-mode/tools-loop/call-model.ts`** — prefer `streamChatWithTools` when present, mapping
   `onDelta` → the existing `onChunk` (`reasoning`→`"thinking"`, `text`→`"text"`). Fall back to
   `completeChatWithTools` otherwise. **Return value and everything below it stay identical.**

That's the whole spike. The agent loop, `dispatchToolCalls`, `handleTextResponse`, edit handling,
and ask/planning are **untouched**.

## Out of scope (spike only proves feasibility)

- NOT migrating ask/planning to native yet (that's the follow-up once the spike is green).
- NOT touching the XML path / `generator.ts` / `agent.ts` streaming loop.
- NOT changing modes or tool permissions.
- NOT implementing for Groq/OpenRouter/Ollama — LM Studio only (the user's daily driver).
- NO change to the agent loop logic.

## Risks to validate IN the spike

1. **Does LM Studio actually stream `tool_calls` incrementally?** Some local servers buffer the tool
   call and emit it whole at the end. If so, streaming still works (text/reasoning stream; the tool
   call just lands in one delta) — the accumulator handles both. Confirm empirically.
2. **`reasoning_content` in stream mode** — confirm the field name LM Studio uses for qwen3.6 in
   streamed tool turns (`delta.reasoning_content` vs `delta.reasoning`). Handle both.
3. **`finish_reason` timing** — usually on the last chunk; capture defensively.
4. **Read timeout** — `fetchWithRetry` has a request timeout; streaming needs a guard against a
   stalled stream (no bytes for N seconds), not just total time.
5. **Mid-stream errors** — SSE `error` events / dropped connections must reject cleanly.
6. **`tool_choice:"auto"` + streaming** — verify the server honors it under `stream:true`.

## Acceptance criteria

1. An agent-mode turn against LM Studio streams reasoning + text **live** (`onChunk` fires
   incrementally, not all-at-once at the end).
2. A turn that calls `read_files` / `edit_file` executes correctly — the accumulated `arguments`
   parse to valid JSON and the tool runs.
3. The returned `ChatCompletionWithTools` (content / toolCalls / finishReason / reasoning) is
   **equivalent** to the non-streaming path for the same prompt.
4. Absent `streamChatWithTools`, `callModel` falls back to `completeChatWithTools` (no regression).
5. The diff is confined to the **3 files above** — the loop and downstream are unchanged.

## If the spike is green — the payoff

ask/planning route through the native engine with restricted (read-only) tool-sets:
- `generator.ts` (1010 lines, the whole Phase 3 target) → **deleted**, not refactored.
- the `agent.ts` XML streaming loop (~250 lines of duplicated queue/continuation) → **deleted**.
- modes become **prompt + tool-permission profiles** over one loop (`generator-tools.ts`, already
  379 lines after Phase 2).
- the `formatMcpToolArgs` XML-only hint becomes unnecessary (native passes real schema).

This is a bigger simplification than any remaining Phase 3/4 extraction, and it removes the
class of bugs (narrate-don't-act, confabulation, guessed args) at the root.

## Rough effort

SSE parser + accumulator (~80–120 lines) · LM Studio method (~10) · `call-model` wiring (~20) +
a characterization test for the accumulator (feed it canned SSE chunks, assert the assembled
result). ~half a day to a green spike against a live LM Studio.

## What was actually built (this spike)

- `providers/model-provider.ts` — `ToolStreamDelta` type + optional `streamChatWithTools` method.
- `providers/openai-tool-caller.ts` — extracted `buildToolsRequestBody` (shared, `stream` flag);
  `ToolCallAccumulator` (exported, pure, the per-index args accumulation); `openaiStreamChatWithTools`
  (SSE reader with cross-chunk buffering → live `onDelta` → assembled `ChatCompletionWithTools`).
- `providers/lm-studio-provider.ts` — `streamChatWithTools` delegating to the shared core.
- `agent-mode/tools-loop/call-model.ts` — prefers streaming when present; forwards **reasoning**
  deltas live (not text — see above); **runtime try/catch fallback** to the non-streaming call so a
  streaming failure can't break a turn.
- Tests: `providers/openai-tool-caller.test.ts` — accumulator unit tests + an end-to-end SSE test
  with mocked fetch (incl. a frame split across network chunks) and a non-ok-throws test.

Unit/integration: green (`tsc` clean, full suite passes). **Acceptance criterion #1 (live token
streaming) needs a real LM Studio run** — that's the one thing canned tests can't cover.

### How to validate live
Run REI in **agent mode** against LM Studio with qwen3.6 and watch a turn: reasoning should appear
**token-by-token** (not all-at-once at the end), and tool calls (`read_files`/`edit_file`) must
still execute. Check `.rei/logs/agent-flow.jsonl` for `"streamed": true` on `[tools] Response`. If
streaming misbehaves, the log shows `streaming failed — falling back` and the turn still completes.
Toggle off by making `streamChatWithTools` absent (or revert the LM Studio method) → non-streaming.
