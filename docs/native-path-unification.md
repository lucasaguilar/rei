# Native-path unification — ask/planning onto the one tools loop

The payoff follow-up to the `streamChatWithTools` spike (see `docs/stream-tools-spike.md`, now
validated live). Goal: route **ask** and **planning** through the SAME native function-calling loop
that **agent** already uses (`executeAgentTurnWithTools` in `agent-mode/generator-tools.ts`), so a
"mode" stops being an *engine choice* (native vs XML interception) and becomes purely a
**prompt + tool-permission profile** over one loop. Endgame: delete `generator.ts` (807 lines) and
the `agent.ts` XML streaming loop.

## Design: a mode is (prompt, tool-permissions)

Today the model already gets its per-mode **system prompt** from `buildMessagesForModel(mode)`. The
only thing that differed structurally was the **engine** and the **tool set**. After this change the
engine is shared; the mode only selects:

| Mode | Built-in tools (`toolsForMode`) | Directive |
|---|---|---|
| `agent` | full `AGENT_TOOLS` (read + edit/create/rewrite + run + git) | edit-batching |
| `ask` / `planning` | `READONLY_TOOLS` (read_files, run_command, git_changes) | read-only investigation |

On top of that the loop always layers `web_search` + `weather` + MCP (with tool-RAG) + mode-scoped
skills — unchanged.

**Why read-only for ask/planning is behavior-preserving:** the old XML path
(`executeAndFormatTurnActions`) only ever handled file *reads*, *commands*, and MCP/web *tool calls*
for those modes — never edit/create/rewrite. `run_command` is intentionally kept (it matches the old
`<execute_command>` capability).

## Status

### Done (2026-06-30) — behind `REI_NATIVE_ASK=true`, tsc + 507 tests green
1. **`contracts/tool-definitions.ts`** — `READONLY_TOOLS` + `toolsForMode(mode)`.
2. **`agent-mode/tools-loop/tool-selection.ts`** — `setupToolSelection` takes `mode` (default
   `"agent"`); uses `toolsForMode(mode)` and `skillsForMode(loadSkills, mode)` instead of hardcoding
   `AGENT_TOOLS` / `"agent"`.
3. **`agent-mode/native-tools-directive.ts`** (new, extracted from generator-tools for SRP/size) —
   `withNativeToolsDirective(messages, mode)` picks agent (edit-batching) vs read-only directive.
   Re-exported from `generator-tools.ts` for back-compat.
4. **`agent-mode/generator-tools.ts`** — `executeAgentTurnWithTools` takes `mode` (default
   `"agent"`), threads it to tool-selection + the directive.
5. **`core/agent.ts`** — new branch BEFORE the XML `streamChat` loop: when `REI_NATIVE_ASK=true` and
   the provider supports `completeChatWithTools`, ask/planning run through
   `executeAgentTurnWithTools({ mode: session.mode, ... })`, streaming live via callModel's
   `streamChatWithTools`. Off by default → no regression.
6. Tests: tool-selection mode-gating (read-only excludes edit/create/rewrite) + directive per mode.

Agent mode is untouched (default `mode = "agent"` everywhere → identical tool set + directive).

### Done (2026-06-30, second pass) — native mode PROMPTS for ask/planning
First live ask run surfaced the conflict we predicted: with the flag on, the model still read files
with `run_command`+`sed`/`grep` (fighting truncation over 4 turns) and leaked a `<call_tool>` tag —
because the **base mode prompt was still the XML one**. `prompts/modes/ask.md` / `planning.md` are
full of `<request_files>` / `<execute_command>` (it even lists `cat` as a recommended read command)
/ `<call_tool>` instructions, which override the loop's native directive.

Fix (mirrors how agent already switches `modes/agent` ↔ `modes/agent-tools`):
- New `prompts/modes/ask-tools.md` + `prompts/modes/planning-tools.md` — native variants: use
  `read_files` (whole file) / `run_command` (read-only explore only), NO XML tags, explicit "NEVER
  read files with cat/head/sed". planning-tools keeps the `## Stage N:` /runplan + bootstrapping
  content verbatim.
- `prompts/prompt-builder.ts` — `buildSystemMessage` adds an `else if (useToolCalling)` branch for
  ask/planning: loads `modes/${mode}-tools` (+ the tool-agnostic `formats/${mode}-format`) and
  OMITS the XML `<call_tool name="use_skill">` skill catalog (skills ride as the native `use_skill`
  tool instead).
- `core/agent.ts` — new `nativeToolsActive(mode)` helper is the single source of truth (prompt
  selection, MCP-tools-via-API-vs-prompt-text, and the dispatch branch all use it). `useToolCalling`
  is now passed for ask/planning too when the flag is on.
- Test `prompts/prompt-builder.test.ts` — asserts the XML↔native mode-prompt swap.

**Residual conflict — RESOLVED:** `.rei/rules.md` (global REI rules, loaded into EVERY mode via
`loadLocalRules`) phrased its edit-discipline rules in XML terms (`<edit>` / `<search>` /
`<request_files>`). Neutralized to tool-agnostic wording (e.g. "edit (search/replace)", "read the
file with read_files") — same discipline, no XML-tag nudge, correct for BOTH the native agent path
(`edit_file`/`rewrite_file`) and read-only ask/planning. (It's user config, edited in the working
tree only.)

### Done (2026-06-30, third pass) — run_command loop-guard
First live PLANNING run looped: the model re-ran the SAME `find … | grep -i agent` 5+ times (identical
reasoning "Let me find this file first") after already locating `src/core/agent.ts`, instead of
calling `read_files` — a classic local-model repetition loop. The native loop deduped read_files but
had NO guard on repeated `run_command`.

Fix:
- `tools-loop/dispatch-tool-calls.ts` — `DispatchContext.commandHistory: Map<string, number>`; the
  `run_command` case intercepts an EXACT repeat (priorRuns ≥ 1) with a nudge ("you already ran this;
  use read_files on the path / write your answer now") instead of re-executing.
- `generator-tools.ts` — owns `commandHistory`; clears it after a turn that queued edits, so a legit
  post-edit re-verification (`npx tsc --noEmit`) can run again. Read-only modes never edit → any
  repeat is a pure loop and stays blocked.
- `prompts/modes/ask-tools.md` + `planning-tools.md` — explicit rule: once a command locates a file,
  read it with `read_files`; never run the exact same command twice.
- Test in `dispatch-tool-calls.test.ts`.

### Done (2026-06-30, fourth pass) — DEFAULT FLIPPED + skills verified
- ask + planning both validated live (planning loop fixed). `nativeToolsActive` now defaults ask/
  planning to the native loop whenever the provider supports tool calls; `REI_NATIVE_ASK=false` is
  the escape hatch back to the XML path during the transition. Providers without tool calling still
  fall through automatically.
- **Skills on the native path: confirmed wired.** `setupToolSelection` exposes `use_skill` (native
  tool) with the mode-scoped catalog (`skillsForMode(mode)`); planning sees `write-spec` +
  `micro-task-decomposition`, agent sees its own. The recipe is fed back as a tool result. Only
  residual was `prompts/skills/write-spec.md` referencing `<request_files>`/`<execute_command>` —
  neutralized to `read_files`/`run_command`. Other skills were already XML-free.

### Done (2026-06-30, fifth pass) — repetition-loop root cause + guard
Live agent + planning runs looped: the model re-issued the SAME command many times (21× `git diff`,
7× `find|grep`) with identical reasoning. Two complementary fixes:

1. **Root cause — preserve-thinking re-feed.** `REI_PRESERVE_THINKING` was defaulted ON (commit
   7147a13). In the native tools loop each iteration's `reasoning_content` accumulates and is re-sent
   every subsequent call (`toApiMessage`), so local models echo their own prior thoughts → the same
   command again. Flipped DEFAULT BACK TO OFF via a single source of truth
   `preserveThinkingEnabled()` in `config/model-runtime.ts` (`=== "true"`, opt-in), used by
   `toApiMessage`, `cleanResponseForHistory`, and `call-model`'s logging. Re-feeding reasoning is
   non-standard (thinking is normally ephemeral-per-turn); the continuity benefit was speculative,
   the loop cost concrete.
2. **Defense-in-depth — run_command loop-guard + escalation.** `dispatch-tool-calls.ts` intercepts an
   EXACT repeat command with a read_files/stop nudge (`commandHistory`) instead of re-executing;
   `blockedRepeatCount` is surfaced so `blocked-repeat-guard.ts` (`evaluateBlockedRepeats`) escalates:
   a turn that was nothing-but-blocked-repeats injects a forceful STOP user message, and a 2nd in a
   row abandons the turn (finalize) instead of spinning to MAX_TURNS. `commandHistory` clears after a
   turn with edits so a legit post-edit `tsc` re-verify still runs.

### Done (2026-07-01) — XML PATH DEMOLISHED 🎉
Provider parity first (Phase 0): mock/gemini/huggingface gained `completeChatWithTools` (gemini+hf via
their OpenAI-compat endpoints reusing the shared `openai-tool-caller`; mock scriptable). Then the
demolition (Phase 1): agent.ts's streamTurn dispatch simplified to native-only; the XML ask/planning
`streamChat` loop + the whole dead non-streaming path (`runTurn`/`generateAssistantResponse` family)
deleted; `nativeToolsActive` simplified + `REI_NATIVE_ASK` removed; `buildSystemMessage` always uses
`*-tools` prompts. Deleted: `generator.ts` (807), `token-streamer.ts` (137), `handle-sr-edits.ts`
(307), `stream-with-continuation.ts` (82) + their tests; 6 XML-only prompts; `formatMcpToolArgs` +
`formatMcpToolsForPrompt`. **Net −3140 lines, tsc clean, 495 tests green.** Native function-calling is
now the ONLY engine across ask/planning/agent. gemini/hf need live validation (no keys locally).

Minor leftovers (optional dead-export sweep, non-blocking): `modelFeedbackToolNames` and some
`action-executor`/`response-handler` extractor exports are now production-dead but still used by the
CLI layer / tests — trim in a later pass.

### Next
- **Validate live**: run REI in **ask** mode against LM Studio with `REI_NATIVE_ASK=true`; confirm
  (a) reasoning/text stream live, (b) the model investigates via `read_files`/`run_command` (not XML
  tags), (c) it cannot and does not mutate files, (d) answers are equivalent/better vs the XML path.
- Then **planning** (same flag; verify plan production still works — plans are persisted via skills /
  run_command, not native write tools).
- Once both are validated, **flip the default** (drop the flag), then **delete** `generator.ts`, the
  `agent.ts` XML streaming loop + `streamTurnWithInterception`, and the now-unused XML extraction
  (`extractCommandRequests` / `extractToolCalls` / `extractFileRequests`) and `executeAndFormatTurnActions`.
- The `formatMcpToolArgs` XML-only hint becomes unnecessary (native passes real schema).

## Out of scope / deferred
- The literal-`<think>`-strips-to-end bug (memory `rei-think-literal-strips-to-end`) — fix after
  unification; the start-anchored regex change is agreed.
