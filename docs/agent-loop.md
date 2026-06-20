# REI — Agent Loop

How a single `agent.streamTurn()` turn flows. The diagram focuses on the **native tools
path** (primary, used by tool-capable local models like Qwen); ask/planning and the XML
fallback are shown as branches.

```mermaid
flowchart TD
    A([streamTurn: user prompt]) --> B{needsCompaction?<br/>&gt;20 non-system msgs}
    B -- yes --> C[compactSession<br/>summarize old msgs<br/>COMPACTOR_MODEL]
    B -- no --> D[Build turn context]
    C --> D
    D --> D1[file tree from scannedFiles<br/>+ RAG repo-map + repo summary]
    D1 --> E[buildTurnUserMessage<br/>enriched message]
    E --> F{REI_CONTEXT_WINDOW &gt; 0?}
    F -- yes --> G[trimContextToBudget<br/>cut RAG/files to fit]
    F -- no --> H{mode + path}
    G --> H

    H -- "ask / planning" --> I[XML streaming path<br/>streamTurnWithInterception<br/>intercepts &lt;execute_command&gt; &lt;call_tool&gt; &lt;request_files&gt;]
    H -- "agent · XML fallback" --> K[generator.ts<br/>&lt;edit&gt; / &lt;wholefile&gt; / &lt;create&gt;]
    H -- "agent · native tools" --> J0

    subgraph LOOP["Agent tools loop — max REI_MAX_TURNS"]
        J0[completeChatWithTools<br/>tools: read_files, edit_file, rewrite_file,<br/>create_file, run_command, search_tools, use_skill, mcp:*] --> M{tool calls?}

        M -- "none (model done)" --> N[FINAL verify · verify cmd<br/>direct: workspace as-is · sandbox: virtual tree]
        N -- pass --> O[finalize · verified = true]
        N -- "fail · retries left" --> P[feed diagnostics back] --> J0
        N -- "fail · no retries" --> Q[finalize · verified = false ⚠]

        M -- yes --> R[execute each tool call]
        R --> R1[read_files → reflects working state<br/>run_command / search_tools / use_skill / mcp]
        R --> S[edit_file / rewrite_file]
        S --> T[apply onto CURRENT content<br/>per file, in order]
        T -- search mismatch --> X[escalate: 2× inject current content · 4× rewrite_file]
        T -- applied --> EM{REI_EDIT_MODE}
        EM -- "direct · default" --> V[WRITE to disk immediately<br/>no per-edit compile-check]
        EM -- sandbox --> U[validate WHOLE virtual tree vs sandbox<br/>ngc -p tsconfig.app.json / tsc --noEmit]
        U -- pass --> V
        U -- compile error --> EF[inject broken + referenced files<br/>ERROR feedback]
        R1 --> Z[feed all tool results back]
        V --> Z
        X --> Z
        EF --> Z
        Z --> J0
    end

    O --> AA[applySREditBatchFS<br/>idempotent: disk already = target]
    Q --> AA
    AA --> AB([yield diffs + verified warning if false])

    I --> AB
    K --> AA
```

## Edit lifecycle (request → modify → verify → persist)

The **default `direct` mode** works like a human/CLI agent (this is the flow that fixed the
edit-loop death-spirals local models hit):

1. **Request context** — the model calls `read_files` (often several in parallel). It reflects
   the real working state, so re-reads show the model its own changes, not stale disk.
2. **Modify** — `edit_file` / `rewrite_file` are applied **straight to disk**, in order. A
   `<search>` that doesn't match the current content is a mismatch → escalation (2× inject the
   exact current content, 4× switch to `rewrite_file`).
3. **Self-verify** — the model runs `run_command` (`tsc`/`ngc`/tests) **whenever it judges it's
   done a coherent unit**, and sees its real edits on disk (no divergence — the bug that made
   the model think "my edits didn't apply" and spiral).
4. **Final verify** — when the model emits a plain-text answer (done), REI runs **one** verify
   of the workspace as-is (honest `verified` flag). On failure it feeds the diagnostics back —
   including the broken file(s) and any module they reference (`resolveReferencedFiles`) — for
   self-correction, bounded by `verifyRetries`.
5. **Done** — edits are already on disk; `applySREditBatchFS` is an idempotent no-op that still
   yields the diffs for display.

> **`sandbox` mode** (opt-in) inserts a guard between steps 2 and 3: each edit is applied to a
> **virtual working tree** (`Map<file, content>`) and the *whole tree* is validated against a
> throwaway sandbox; only **green** state is persisted to disk. It never leaves broken code on
> disk but copies the workspace per edit and tends to saturate local models. See *Edit modes*.

## Edit modes (`REI_EDIT_MODE`)

Two ways the loop turns model edits into validated files on disk:

- **`direct`** (DEFAULT, "Claude Code style") — edits are applied **straight to disk**, with
  **no per-edit compile-check**. The model self-verifies via `run_command` (it sees the real
  disk) and REI runs **one final verify** when the model finishes (sandbox copy of the current
  disk, i.e. `validateProposedPatches({edits: []})`), feeding errors back for self-correction.
  **Lighter** (no per-edit sandbox copies) and avoids the reject-per-edit loop — at the cost of
  leaving partial edits on disk if the task aborts (recoverable via git). Search-mismatch
  detection still runs (against real disk, so it's accurate).
- **`sandbox`** (opt-in, `REI_EDIT_MODE=sandbox`) — the virtual-tree flow above: every edit is
  validated against the **cumulative** tree in a throwaway sandbox, and only **green** state is
  persisted. Never leaves broken code on disk, but each validation **copies the workspace** and
  the reject-per-edit pressure tends to **saturate local models** (the loop they got stuck in).

`direct` is the default because it works for both local and cloud models. Reach for `sandbox`
only when "never touch disk until it's green" outweighs speed (e.g. a very weak model with no
git safety net).

## Key gates & guardrails

- **Compaction** (count-based, &gt;20 msgs) — the only context guardrail active when
  `REI_CONTEXT_WINDOW=0`; trimming + overflow warning need a non-zero window.
- **Compile/type verification** — runs the project's verify command (below). In `direct` mode:
  the model self-verifies + one final verify. In `sandbox` mode: every edit validates the whole
  cumulative tree. Either way the AST/compile strength is intact — only the timing differs.
- **Verify command** is project-type aware (`project-type.ts`): Angular → `ngc` (catches
  template errors), plain TS → `tsc --noEmit`. (`REI_TDD_MODE=true` appends `npm run test`.)
- **Search-mismatch escalation:** 2 mismatches → inject exact current content; 4 → `rewrite_file`.
- **Referenced-file injection** (`resolveReferencedFiles`, per-language adapter): a compile
  error naming another module (e.g. TS2305 "no exported member") injects that file so the model
  edits provider + consumer together. TS/Angular implemented; C# falls back to the generic
  "file where the error appears".
- **Skills:** `use_skill` loads a recipe on demand, **mode-scoped** via `modes:` frontmatter.
  Native loop exposes agent-mode skills in the tool schema; ask/planning inject the mode's
  catalog and invoke via `<call_tool name="use_skill">`. SDD chain (`[planning]`):
  `write-spec` → `micro-task-decomposition` → `/runplan` → verify.
- **run_command** is for exploration/verification; it now sees on-green edits. `rm -rf` blocked.

## Trade-offs & known limitations (for review)

- **Apply-on-green persists partial work**: if a task ultimately fails/aborts, the green edits
  already written to disk remain (recoverable via git). This mirrors how a human/CLI agent
  works and is the cost of letting the model verify its own work mid-turn.
- `verified: true` means "what was applied compiles", NOT "task complete".
- In-loop `read_files` accumulation is not budget-controlled (can grow the window mid-turn).
- ask/planning use the XML path → a tool-trained model may leak native `<tool_call>` syntax
  (stripped via `stripNativeToolSyntax`); that path does **not** use the virtual tree.
- agent-flow logging does not capture streamed text for ask/planning (hard to analyze post-hoc).
```
