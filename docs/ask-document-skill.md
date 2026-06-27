# Skill: `ask-document` — grounded Q&A over a document with verified citations

Status: **Phase 1 (MVP) IMPLEMENTED** (`src/skills/ask-document/`, `/ask-document` command).
Builds on the OCR output (`docs/ocr-architecture.md`) and the parametrizable RAG embedder
(`docs/rag-architecture.md`). Phases 2–3 (hybrid retrieval, page-range, multi-doc) proposed.

## Goal

Ask questions about a large document (an OCR'd `.ocr.md`, or any text file too big for the
context window) and get answers that are **provably grounded in the text** — each claim carries
a page citation and a *verbatim quote that is verified to exist in the source*. The model
**cannot** answer from outside knowledge, and **must** say "not found" when the text doesn't
support it. This is the text analog of the MRZ check-digit idea: don't trust the model's claim
— verify it against the source.

## Why (the problem)

An 84-page book is ~33k tokens — it doesn't fit a 32k local window, so you can't `@`-reference
the whole `.ocr.md` and ask over it. And even when text fits, a model will happily blend in
plausible-but-absent details. Both are solved by **retrieve-then-read with verified citations**.

## Architecture — retrieve → read → verify

```
question
  │
  1. RETRIEVE   embed query → top-k most-similar chunks (each carries its page)
  │             (+ optional lexical/BM25 merge for exact terms/names)
  │
  2. READ       feed ONLY those chunks + a strict prompt:
  │             "Answer using ONLY these excerpts. For each claim cite the page and a
  │              VERBATIM quote. If it isn't in the excerpts, say 'not found in the text'."
  │
  3. VERIFY     for each quote the model returned → string-match it against the source
  │             ├─ found        → citation ✅ (verified, really in the text)
  │             └─ not found    → ⚠️ flag / drop (hallucination caught, deterministically)
  │
  4. RETURN     answer with per-claim [p.N ✅] + a faithfulness summary (verified/total)
```

The three pillars that kill hallucination:
1. **Only the retrieved chunks are in context** — no full doc, no outside knowledge to "fill in".
2. **Verbatim quote + page required per claim** — every assertion must point at real text.
3. **Deterministic quote verification** (string match against the source) — independent of how
   good the model is. A quote that isn't literally in the document is rejected.
Plus: **"not found" is enforced** so the model refuses instead of inventing.

## Components

| # | Component | File | Reuse / Build |
|---|---|---|---|
| 1 | **Page-aware chunker** | `src/skills/ask-document/chunker.ts` | Build. Split on OCR page markers (`-- N of M --` / `--- Page N ---`); each chunk tagged with its page. Fallback: fixed ~400-token chunks with overlap. |
| 2 | **Indexer** (chunk → embed → store, cached by file hash) | `src/skills/ask-document/indexer.ts` | **Reuse the RAG embedder** (`docs/rag-architecture.md`). Cache index at `.rei/ocr/<file>.index.json`; re-index on hash/dim change. |
| 3 | **Retriever** (top-k semantic; optional lexical merge) | `src/skills/ask-document/retriever.ts` | Build. Cosine top-k + optional grep/BM25 hybrid. |
| 4 | **Grounded-answer prompt** | `src/skills/ask-document/prompt.ts` | Build. The strict "only-from-excerpts + cite + refuse" instruction. |
| 5 | **Quote verifier** (the killer piece) | `src/skills/ask-document/verify.ts` | Build. Normalize whitespace → substring match against the source; mark ✅/⚠️; page check. |
| 6 | **Tool + skill wrapper** | `src/skills/ask-document/index.ts` | Build. `ask_document(file, question)` tool + skill manifest. |

## The quote verifier (detail)

This is what makes answers trustworthy regardless of model quality.

```ts
// Normalize both sides (collapse whitespace, optional lowercase) then check containment.
function verifyQuote(quote: string, sourceText: string): "verified" | "fuzzy" | "fabricated" {
  const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
  const q = norm(quote), src = norm(sourceText);
  if (q.length >= 12 && src.includes(q)) return "verified";       // exact (normalized)
  if (tokenOverlap(q, src) >= 0.9) return "fuzzy";                 // model lightly reworded
  return "fabricated";                                            // not in the source → drop/flag
}
```
- Verify against the **full document text**, not just the retrieved chunk (a quote may span a
  chunk boundary).
- **Page attribution:** the cited page = the page of the chunk the quote came from; confirm the
  quote appears in *that page's* text for an accurate `[p.N]`.
- A claim whose quote is `fabricated` is removed from the answer (or shown struck-through with
  ⚠️), and counted against the faithfulness score.

## Output shape (sketch)

```jsonc
{
  "answer": "Harari argues information networks, not truth, hold societies together …",
  "claims": [
    { "text": "networks are built on shared stories, not facts",
      "page": 23, "quote": "information networks are held together by …", "status": "verified" }, // ✅
    { "text": "he cites a 2019 study", "status": "fabricated" }   // ⚠️ dropped — not in the text
  ],
  "faithfulness": { "verified": 4, "total": 5 },   // 1 claim was unsupported
  "notFound": false
}
```
Rendered: the prose answer + `[p.23 ✅]` per claim + a footer like `4/5 claims verified — 1
unsupported claim was removed.`

## Invocation

- **Skill:** `/ask-document <file> <question>` (mode-scoped, fits REI's skills loader).
- **Auto:** when the user references `@<file>.ocr.md` (or any large text file) with a question,
  route through this skill instead of dumping the (truncated) file into the prompt.
- **Tool:** `ask_document(file, question)` callable by the agent.

## Embedder — parametrizable & multilingual

The retriever turns chunks into vectors with an **embedding model** (today Xenova
`all-MiniLM-L6-v2`, in-process via transformers.js — English-centric, dim 384). For Spanish /
multilingual docs (Nexus, etc.) a multilingual embedder is a real quality jump. This generalizes
the existing parametrizable-embedder work (`docs/rag-architecture.md`).

**`Embedder` interface** (`src/rag/embedder.ts`): `embed(texts: string[]) → number[][]` + `dim`
+ `id`. Pluggable backends selected by env — the SAME embedder must index AND query.

| Backend | Model examples (multilingual) | Infra | Note |
|---|---|---|---|
| **Xenova** (current) | `Xenova/multilingual-e5-small/large`, `Xenova/bge-m3` (ONNX) | none, in-process | zero-config default; swap the ONNX model id |
| **LM Studio** `/v1/embeddings` | `bge-m3`, `multilingual-e5-large`, `qwen3-embedding` | **the LM Studio you already run** | ← recommended for this user: GPU, multilingual, parametrizable |
| **Ollama** `/api/embeddings` | `bge-m3`, `nomic-embed-text`, `mxbai-embed-large` | Ollama server | if running Ollama |
| **Cloud** `/v1/embeddings` | OpenAI / Voyage / Gemini embeddings | API | max quality, costs/privacy |

**THE big implication — dimension change ⇒ REINDEX.** Different embedders emit different vector
dims (MiniLM 384, e5-large / bge-m3 1024, qwen3-embedding 1024–4096). A stored index is tied to
one model+dim; switching embedder **invalidates every index** (the code RAG index *and* every
`.ocr.md` doc index). Required handling: store `{embedderId, dim}` in the index metadata; on a
mismatch, **auto-reindex** (or warn + rebuild). Indexing + querying must always use the same
embedder, else the vector spaces don't align and retrieval is garbage.

**What it implies to implement:** an `Embedder` interface + a provider factory (mirrors the
model-provider factory) with Xenova / OpenAI-compatible (`/v1/embeddings`, covers LM Studio +
cloud) / Ollama backends; index metadata + reindex-on-mismatch; and wiring both the code RAG and
the ask-document indexer through it. Config below. Recommended default for this user: keep Xenova
as the zero-config fallback, point `REI_EMBEDDER_PROVIDER=llmstudio` at a multilingual model
(e.g. `bge-m3`) for the quality jump on Spanish docs.

> Note: this is about EMBEDDING quality, not chunking. Chunking is heuristic text-splitting (by
> page/paragraph/tokens) and needs no model. A separate optional upgrade is *semantic chunking*
> (split at topic boundaries) — orthogonal to the embedder.

## Config / env

```bash
REI_EMBEDDER_PROVIDER=xenova   # xenova | llmstudio | ollama | openai  (default xenova, zero-config)
REI_EMBEDDER_MODEL=bge-m3      # model id for the chosen backend
REI_EMBEDDER_BASE_URL=         # for server/cloud backends (e.g. LM Studio /v1)
REI_EMBEDDER_DIM=              # optional override; else detected from the model
REI_DOC_RETRIEVE_K=6           # top-k chunks fed to the model
REI_DOC_CHUNK_TOKENS=400       # chunk size
REI_DOC_HYBRID=1               # also use lexical/BM25 retrieval, merged with semantic
REI_DOC_VERIFY=1               # enforce quote verification (default on)
REI_DOC_MIN_QUOTE_CHARS=12     # ignore trivially-short "quotes" in verification
# reuses the RAG embedder env (see rag-architecture.md)
```

## Phases

1. **MVP:** page-aware chunker + reuse RAG embedder + top-k retrieve + grounded prompt + quote
   verification + page citations + enforced "not found". Cache index by file hash.
2. **Hybrid + scoring:** lexical/BM25 merge, faithfulness score, optional re-ranking.
3. **Scope + memory:** page-range scoping (`pp. 20-40`), multi-document, follow-up questions
   that remember the retrieved context.

## Risks / notes

- **Retrieval misses** → if the relevant chunk isn't retrieved, the honest answer is "not found"
  (better than inventing). Tune `K` / hybrid to reduce misses.
- **Verbatim drift** → models lightly reword quotes; the `fuzzy` tier (token-overlap) avoids
  rejecting genuine-but-paraphrased quotes while still catching fabrications. Keep the threshold
  strict.
- **OCR noise** → on scanned docs the source text may have OCR errors, so an exact quote match
  can fail on a garbled char; `fuzzy` covers most, and the page citation still lets the user
  verify by eye.
- **Index staleness** → re-index when the file hash or embedder dimension changes (see the
  pending parametrizable-embedder work).
