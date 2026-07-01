# Spike: Accounting oracle on REI's core — proving the pattern transfers beyond code

Status: **PROPOSAL / spike design.** Not implemented. Deferred behind the XML-path demolition.

## Thesis

REI's durable pattern is NOT "a coding agent". It is **"a local/private/offline agent that
self-corrects against a hard verifier."** Coding was v1; the compiler was just the first oracle.
This spike tests whether the pattern transfers to a second domain — **accounting/finance-ops** —
by swapping the oracle (compiler → numeric grounding + arithmetic), reusing the whole loop.

Accounting is the most tractable second vertical because **numbers are checkable** the way legal
prose is not: a reported figure must (a) appear verbatim in the source document and (b) satisfy an
arithmetic constraint. That is a clean, mechanical oracle — the analog of "does it compile".

## The parallel

| | Coding (today) | Accounting (this spike) |
|---|---|---|
| Input corpus | typed source files | invoices, bank statements, receipts, ledger (many are scanned → OCR) |
| Agent produces | edits | field extractions + journal entries + reconciliations |
| **Oracle** | compiler (ts-morph in-memory program → diagnostics) | **grounding + arithmetic** (see below) |
| Self-correction | reject non-compiling edit → retry → converge | reject ungrounded/miscomputed figure → retry → converge |
| The magic | model can be ~60% right; the compiler filters and it retries | model can hallucinate a number; the verifier rejects it and it retries |

## Why this is a small surface, not a rewrite

REI already has a **pluggable-verifier seam**. `src/tools/compile-check-factory.ts` dispatches by
`detectProjectType(workspacePath)` to `typescript-compile-check.ts` / `csharp-compile-check.ts`, both
conforming to the **generic** `GenericVirtualBatchResult` / `GenericDiagnostic` contract in
`compile-check-core.ts`. Everything above the factory — `validateProposedPatches`
(`agent-mode/helpers/patch-helpers.ts`) → the self-correction retry in
`tools-loop/handle-text-response.ts` + the final verify in `tools-loop/turn-outcomes.ts` — is
**verifier-agnostic**. The oracle is *another adapter*, not a new loop.

The mode system we just built (a mode = system prompt + tool-permission profile, `toolsForMode` in
`contracts/tool-definitions.ts` + the `-tools` prompt in `prompts/prompt-builder.ts`) is the re-skin
mechanism: add an `accounting` profile the same way ask/planning were added.

## Reuse map (≈70–80% of the machinery, as-is)

| Component | File(s) | Reuse |
|---|---|---|
| Native tool-calling loop | `agent-mode/generator-tools.ts`, `agent-mode/tools-loop/*` | as-is; swap the tool-set |
| Modes = prompt + permission profile | `contracts/tool-definitions.ts` (`toolsForMode`), `prompts/prompt-builder.ts`, `prompts/modes/*-tools.md` | add an `accounting` profile |
| OCR / document ingestion | vision sidecar + `pdf-parse` v2 page-render → vision OCR (see `docs/ocr-architecture.md`) | **direct** — scans → text is the hard part, already done |
| Offline RAG | xenova local embeddings + retriever | engine reuses; **swap the AST chunker for a doc/page/table/line chunker** |
| Local/hybrid routing | `MODEL_PROVIDER` / `AGENT_MODEL_PROVIDER` | as-is (local extract/Q&A, cloud for hard reasoning) |
| MCP | `tools/mcp/*` | connect QuickBooks/SAP/a local SQLite ledger/a bank API as tools |
| Telemetry / audit trail | spans + `.rei/logs/agent-flow.jsonl` | as-is — worth MORE here (auditability sells) |
| Verifier factory + self-correction | `tools/compile-check-factory.ts`, `patch-helpers.ts`, `tools-loop/handle-text-response.ts` | as-is; add an adapter |

## What to build (small, bounded)

1. **The oracle** — `tools/accounting-check.ts`, a new adapter conforming to
   `GenericVirtualBatchResult` and registered in `compile-check-factory.ts` (or a sibling factory).
   It validates a proposed extraction/entry set and returns `diagnostics` in the SAME shape the
   compiler adapters do, so the existing retry loop consumes it unchanged. Checks:
   - **Grounding** — every reported number must appear verbatim in the source OCR text (token/regex
     match against the document). No hallucinated figures.
   - **Arithmetic** — line items sum to subtotal; subtotal + tax = total; VAT = base × rate;
     **debits = credits** (double-entry); reconciliation delta = 0.
   - **Schema** — valid dates, consistent currency, required fields present.
2. **Domain tools** (analogs of read_files/edit_file), added to a `toolsForMode("accounting")` set:
   - `read_documents` (OCR + extract) — reuses the OCR layer.
   - `extract_fields` (structured extraction with grounding).
   - `reconcile` (match invoices ↔ payments ↔ ledger).
   - `post_entry` (journal entry — validated by the oracle BEFORE commit, like edit_file by the compiler).
   - `run_query` (over a local ledger DB) — analog of run_command.
3. **Prompt profile** — `prompts/modes/accounting-tools.md`: "you extract/reconcile; every number
   must trace to a source document; NEVER invent a figure."
4. **Doc/table-aware chunker** for the RAG (replaces the AST chunker for this corpus type).
5. **Domain schemas** — chart of accounts, invoice/statement schema (config).

## The one real interface gap (be honest)

The generic contract today is `applyVirtualBatch(workspacePath, edits: AgentSREdit[])` — shaped
around search-replace **code edits**. An accounting "proposed change" is an extraction/entry, not a
search-replace. So the spike must either **generalize the "proposed change" contract** (from
`AgentSREdit` to a neutral shape) OR plug the oracle in at the tool-dispatch/validation layer
(`tools-loop/dispatch-tool-calls.ts` + a validate-before-commit step like `apply-edit-batch.ts`).
This is adapting an interface that already exists — not inventing the loop.

## Minimal spike (≈1 day) — prove the ORACLE, not the vertical

Do NOT build the product. Prove the transferable claim:

1. One scanned invoice → OCR (reuse existing) → `extract_fields`.
2. A minimal `accounting-check` that enforces grounding + `sum(line_items) == total`.
3. **Adversarial test:** prompt the model to report a wrong/hallucinated total → assert the verifier
   REJECTS it and the existing self-correction loop makes the model retry to a grounded, arithmetic
   figure (or honestly flag "cannot ground this number").
4. All offline, local model, with the audit trail in `agent-flow.jsonl`.

## Acceptance criteria

1. A figure that is not present in the source document is rejected (grounding).
2. A total that doesn't equal the sum of its line items is rejected (arithmetic), and the model
   self-corrects via the SAME loop used for compile errors.
3. The oracle returns `GenericDiagnostic`-shaped results consumed by the unchanged retry path.
4. Zero network egress; runs on a local model end-to-end.
5. The diff is confined to: the new adapter, the domain tool-set, the prompt profile, the chunker,
   and the (generalized) proposed-change contract — the loop is untouched.

## Honest caveats

- **OCR quality is the real failure point** (garbage-in). But vision-OCR is REI's strong part, and
  the grounding check HELPS: an unreconcilable number gets flagged, not swallowed.
- **Extraction of varied layouts is a crowded field** (Rossum/Docparser). The wedge is NOT extraction
  — it's **offline + local + verifier + agentic** (ask, reconcile), not just parse.
- **The oracle covers FIGURES and ARITHMETIC, not accounting JUDGMENT** ("is this the right account
  to post to?" has no clean oracle) → human-in-the-loop. Exactly the coding parallel: the compiler
  proves it compiles, not that the design is right.
- **Legal weight → human-in-the-loop is mandatory.** Position as "an assistant that cannot lie about
  numbers," never "an autonomous accountant."

## If the spike is green — what it proves

That the "local agent + domain oracle" pattern transfers beyond code, i.e. REI's core is a
**verifier-in-the-loop private agent framework**, first proven on the compiler, now on arithmetic.
That is the reframe that lets REI scale across industries WITHOUT shedding its moat — provided each
vertical brings a real oracle (offline alone = commodity RAG chatbot). See the strategic thread /
`docs/config-doctor-proposal.md` sibling analyses.
