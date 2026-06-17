# AGENTS.md — REI Agent Specification

> **Scope note:** this file documents REI for people (and agents) working **on the REI codebase**.
> It is NOT sent to REI's runtime models — REI's system prompt is assembled from `prompts/**` plus
> the target workspace's `.rei/rules.md`. Keep this file accurate to the current code; it is the
> contributor-facing source of truth.

## What is REI?

REI (Repository-Aware AI) is a personal, local-first CLI coding agent that operates directly on a
repository. It reads and reasons about the codebase using only the provided context, proposes and
**applies** changes, and validates every edit against the project's real compiler before keeping it.

It targets **local models** (via LM Studio / Ollama) with optional cloud providers, and is built
around one core bet: **trust nothing the model says — verify every edit against ground truth.**

---

## General behavior rules

- **No hallucination.** Never invent files, APIs, code, or behavior not present in the context.
- **Respect context boundaries.** If a file preview is truncated, acknowledge it; never reconstruct.
- **Act, don't narrate.** In agent mode, emit the tool call — a turn that *describes* an action
  without performing it accomplishes nothing.
- **Be direct and grounded.** Answer first, technical, repo-specific. State what's missing instead
  of guessing.

---

## Modes

REI has three modes (`SessionMode` in `src/chat/types.ts`):

- **ask** — answer questions about the repo. No unsolicited plans, no edits.
- **planning** — produce a structured implementation plan. No edits. Plans can be persisted and
  executed stage-by-stage via `/runplan stage N`.
- **agent** — execution mode: read, propose, and apply concrete edits, validated in a sandbox.

---

## Agent execution: TWO paths

Agent mode has two distinct execution paths. Which one runs is decided in `prompt-builder.ts` /
`agent.ts` (`useToolCalling`):

### 1. Native tool-calling (PRIMARY)
For models/providers that support the OpenAI function-calling API (e.g. qwen via LM Studio).
- Driver: `generator-tools.ts` → `completeChatWithTools` → `openai-tool-caller.ts`.
- Prompt: `prompts/modes/agent-tools.md` + `prompts/formats/agent-format-tools.md`.
- The model emits structured `tool_calls`; REI executes them in a loop.
- **This is the path to optimize for** — it's what capable local models (Qwen family) use.

### 2. XML tags (FALLBACK)
For models/providers WITHOUT reliable native function-calling — the model emits XML tags REI parses.
- Driver: `generator.ts` (streaming, intercepts `<edit>`, `<create>`, `<request_files>`, `<call_tool>`).
- Prompts: `prompts/modes/agent.md` (search-replace, default) or `prompts/modes/agent-wholefile.md`
  (whole-file, when `AGENT_EDIT_FORMAT=wholefile`).
- Lower priority — maintained as a compatibility fallback.

> A model trained for tool-use (Qwen) follows path 1 reliably. Chat-first models (e.g. Gemma) tend to
> narrate instead of emitting tool calls — prefer a tool-trained model for agent work.

---

## Agent tools (native path)

Defined in `src/contracts/tool-definitions.ts`:

- **read_files** — read file contents before editing (never guess exact code).
- **edit_file** — search-and-replace edit; `search` must match the file verbatim.
- **rewrite_file** — overwrite a file's full content (no `search` needed). Fallback when `edit_file`
  repeatedly fails to match. REI fills the `search` with the on-disk content, so the model can't miss.
- **create_file** — create a new file.
- **run_command** — shell, **exploration/verification only** (find, grep, `ng build`, tests). Writing
  files via shell (`sed -i`, `>` redirects, `python`) is discouraged by prompt; destructive
  recursive deletes (`rm -rf`) are blocked by the command-executor's security guard.
- **search_tools** — meta-tool (tool-RAG). When an MCP server exposes > 25 tools, REI hides them
  behind this and the model loads relevant ones on demand (keyword search, no embeddings).
- **MCP tools** — appear as `mcp:server/tool` when MCP servers are connected (see `rei.config.json`,
  workspace or global `~/.rei`). Used the same as built-in tools.

---

## Validation — the core strength

Every edit is validated **before** it touches the real filesystem:

1. **Sandbox:** edits are applied to a temp copy of the workspace (`node_modules` symlinked).
2. **Verify command:** the project-type-aware compiler runs against the sandbox
   (`src/workspace/project-type.ts`). E.g. **Angular → `npx ngc -p tsconfig.app.json --noEmit`**
   (ngc, not bare tsc — tsc is blind to Angular template errors); plain TS → `tsc --noEmit`.
   Override with `REI_SANDBOX_VERIFY_COMMAND`.
3. **In-loop (tools path):** each batch of edits is validated; failures are fed back to the model.
4. **Search-mismatch escalation:** after 2 consecutive `search` mismatches REI injects the file's
   exact content; after 4 it instructs the model to use `rewrite_file`.
5. **Final verify:** when the model finishes, the full combined edit set is verified once more; on
   failure the model gets up to `MAX_VERIFY_RETRIES` self-correction attempts.
6. **Honest `verified` flag:** `ExecutionResult.verified` reflects the real final-verify result, not
   an optimistic heuristic. `verified: true` means *"what was applied compiles"* — NOT *"the task is
   complete"* (a model can apply a partial, compiling change and stop).

---

## Context & token budget

Unified in `src/config/model-runtime.ts` (single source of truth):

- **`REI_CONTEXT_WINDOW`** — REI's trimming budget (input + output). `0` = no trimming. Should match
  the model's loaded context in LM Studio (≥ 30000 recommended for agent work that reads files —
  smaller windows truncate mid-turn).
- **`REI_MAX_OUTPUT_TOKENS`** — output cap, sent on both the non-tools and tools paths. ~8192.
- **`REI_MAX_TURNS`** — max agent-loop iterations per turn.

Trimming + the MCP-tools-overflow warning only activate when `REI_CONTEXT_WINDOW > 0`.

---

## Prompt assembly

`src/prompts/prompt-builder.ts` composes the system prompt (NOT this file):

```
shared/base  +  shared/response-rules  +  modes/<mode>  +  formats/<mode>-format
```

For agent mode the mode/format pair depends on the execution path (tools vs XML, see above).
Per-workspace conventions are injected from `{workspace}/.rei/rules.md` (`loadLocalRules`).

### Adding a new mode
1. Add the value to `SessionMode` in `src/chat/types.ts`.
2. Create `prompts/modes/<mode>.md` and `prompts/formats/<mode>-format.md`.
3. Wire any special injection in `src/prompts/prompt-builder.ts`.

See `docs/prompt-architecture.md` for the full pipeline.

---

## Recommended setup for local models

- **Agent model:** a tool-trained model (e.g. `qwen/qwen3.6-35b-a3b` MoE — fast/cool, or `qwen3.6-27b`).
- **LM Studio:** load the agent model with **≥ 30000 context** and **full GPU offload**; enable
  *Only Keep Last JIT Loaded Model* so per-mode model swaps don't blow memory.
- **`.env`:** `REI_CONTEXT_WINDOW` matching the loaded window, `REI_MAX_OUTPUT_TOKENS=8192`.
- Avoid heavily-quantized / chat-first models for the agent path — they narrate instead of calling
  tools and hallucinate completed actions.
