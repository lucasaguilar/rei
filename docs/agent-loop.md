# REI — Agent Loop

How a single `agent.streamTurn()` turn flows today. The diagram focuses on the
**native tools path** (primary, used by tool-capable local models like Qwen);
ask/planning and the XML fallback are shown as branches.

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

        M -- "none (model done)" --> N[FINAL verify<br/>validateProposedPatches all pendingEdits<br/>vs sandbox + verify cmd]
        N -- pass --> O[finalize · verified = true]
        N -- "fail · retries left" --> P[feed diagnostics back] --> J0
        N -- "fail · no retries" --> Q[finalize · verified = false ⚠]

        M -- yes --> R[execute each tool call]
        R --> R1[read_files / run_command / search_tools<br/>use_skill / mcp → feed result back]
        R --> S[edit_file / rewrite_file → queue batch]
        S --> U[batch validate vs disk<br/>verify cmd: ngc -p tsconfig.app.json / tsc --noEmit]
        U -- pass --> V[push to pendingEdits]
        U -- "search mismatch x2" --> X[inject exact file content]
        U -- "search mismatch x4" --> Y[instruct rewrite_file]
        U -- compile error --> EF[ERROR feedback]
        R1 --> Z[feed all tool results back] 
        V --> Z
        X --> Z
        Y --> Z
        EF --> Z
        Z --> J0
    end

    O --> AA[applySREditBatchFS<br/>write pendingEdits to disk]
    Q --> AA
    AA --> AB([yield diffs + verified warning if false])

    I --> AB
    K --> AA
```

## Key gates & guardrails

- **Compaction** (count-based, &gt;20 msgs) — the only context guardrail active when
  `REI_CONTEXT_WINDOW=0`; trimming + overflow warning need a non-zero window.
- **Per-batch validation** (against on-disk content — what the model sees) + **final
  combined verify** before applying. `verified` reflects the real compiler result.
- **Verify command** is project-type aware (`project-type.ts`): Angular → `ngc` (catches
  template errors), plain TS → `tsc --noEmit`.
- **Search-mismatch escalation:** 2 mismatches → inject the file; 4 → switch to `rewrite_file`.
- **Skills:** `use_skill` loads a recipe on demand (catalog always present, body only when invoked).
- **run_command** is for exploration/verification; destructive `rm -rf` is blocked.

## Known limitations (for review/improvement)

- `verified: true` means "what was applied compiles", NOT "task complete".
- In-loop `read_files` accumulation is not budget-controlled (can grow the window mid-turn).
- ask/planning use the XML path → a tool-trained model may leak native `<tool_call>` syntax
  (tolerated/stripped by the streamer).
- agent-flow logging does not capture streamed text for ask/planning (hard to analyze post-hoc).
