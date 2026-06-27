# OCR Architecture — Images, PDFs, Documents

Status: **Phase 1 (images + digital PDFs) DONE. Phase 2 page-render → OCR (scanned PDFs)
DONE.** Phase 2 Tesseract + Phases 3–4 proposed.

REI can already OCR **images** today via the vision sidecar (`src/tools/vision-sidecar.ts`):
the attached image goes full-resolution to the configured vision model
(`REI_VISION_MODEL`, e.g. qwen3-vl), which transcribes visible text. This document
defines how that grows into a professional, multi-format OCR capability — and what the
minimal MVP (Phase 1) is.

## Goal

Reference an image **or** a PDF → REI extracts the text/tables → returns it as REI's
answer (and can save it). Reuse the existing vision sidecar; add document handling behind
the same input seam.

## Reused seams (don't reinvent)

- **Single entry point:** `describeAttachedImages(userText, workspace)` →
  `{ augmentedPrompt, images }`, called from `src/cli/helpers/input-turn.helpers.ts`. All
  OCR hangs here.
- **Vision config:** `getVisionConfig()` → `{ baseUrl, apiKey, model }` from
  `REI_VISION_MODEL` / `REI_VISION_BASE_URL` / `REI_VISION_API_KEY`.
- **Full-resolution send:** the sidecar base64-encodes the file as-is (no downscale), so
  fine text (IDs, MRZ) stays sharp; the model does its own tiling.
- **Saving:** agent mode already writes files — "save this to data.md" works today.

## Engines & routing (the full picture)

For OCR, the **vision encoder** does the perception; in a MoE model (e.g. qwen3.6-35b-a3b)
the sparsity is in the LLM decoder, **not** the vision encoder — so an MoE's OCR quality
depends on its encoder, not its active-param count.

| Engine | Strong at | Weak at | Install |
|---|---|---|---|
| `pdf-parse` (text layer) | digital PDFs — exact, instant | scanned PDFs (no text) | zero-install |
| Vision model (qwen-vl) | layout, **tables**, handwriting, markdown | non-deterministic, may misread fine alphanumerics | already present (local) |
| Tesseract (`tesseract.js`) | clean printed text, **deterministic**, confidence | tables/layout, handwriting | bundleable (WASM) |
| Cloud OCR (Textract/GVision) | best accuracy, forms/tables | external, cost, privacy | optional |

**Router strategy (text-first, vision-fallback):** digital PDF → `pdf-parse`; image / scan
→ vision (or Tesseract); tables/handwriting → vision; high-stakes → add MRZ/check-digit
or cloud.

## ───────────────────────────────────────────────
## Phase 1 — MVP (this phase)

**Scope:** photo/image → OCR via the configured vision model; **digital** PDF → text via
`pdf-parse`; result returned as REI's answer; saving via the existing agent write tools.

### Pieces
1. **OCR-aware prompt** — replace the screenshot/code-biased default with one that also
   transcribes documents/forms/IDs verbatim and renders **tables as markdown tables**,
   preserving structure. Covers screenshots AND documents (no intent detection needed).
2. **PDF text extraction** — `src/ocr/pdf-text.ts`: `extractPdfPaths(text, workspace)` +
   `extractPdfText(path)` (via `pdf-parse`, zero-install). Digital PDFs only.
3. **Generalize the seam** — `describeAttachedImages` also detects `.pdf` paths, extracts
   their text, and appends it to `augmentedPrompt` (returns `documents` alongside `images`).

### Flow
```
photo.jpg  → vision sidecar (OCR prompt)  → data as REI's answer
doc.pdf    → has text layer? → pdf-parse  → text as REI's answer
                            → no text (scanned) → "convert to image / Phase 2"
"save that to data.md"     → agent write tool (already exists)
```

### Out of scope for the MVP (and that's fine)
- **Scanned PDF** (no text layer): needs page rendering → Phase 2. (A *photo* of a passport
  is an image → covered by the MVP.)
- **Table fidelity from PDFs:** `pdf-parse` flattens tables (raw text). Tables come out well
  via the **vision** path (image) with the markdown-table prompt. Nice PDF tables → Phase 2.
- Tesseract, MRZ validation, caching, preprocessing, per-task model presets → later phases.

### Effort
Small. ~80% already works (images). Only genuinely new: `pdf-parse` + the OCR prompt. No
native binaries, no agent-loop changes.

## ───────────────────────────────────────────────
## Phase 2 — Scanned PDFs (page render → OCR)

**Page render → vision OCR: IMPLEMENTED (2026-06-26).** A scanned PDF (no text layer) is
rasterized page-by-page and each page is OCR'd by the vision model — reusing the SAME engine
that already reads photos.
- `src/ocr/pdf-render.ts` `renderPdfPages(path, {maxPages, scale})` → per-page PNG data URLs
  via **pdf-parse v2 `getScreenshot`** (built on pdfjs — **ZERO new dependency**, verified to
  render in Node). The originally-proposed pdfjs+canvas/poppler route was unnecessary.
- `describeImageDataUrl(dataUrl)` added to the sidecar so rendered pages OCR without temp files.
- `describeAttachedImages` routes: text layer → pdf-parse; no text layer → `ocrScannedPdf`
  (render → OCR each page → `--- Page N ---` markers). Requires a vision model; if none, a
  clear message.
- Page budget: `REI_OCR_PDF_MAX_PAGES` (default 20) bounds vision calls; `REI_OCR_PDF_SCALE`
  (default 2) controls render sharpness; a truncation note is appended when the doc is longer.

**Still pending in Phase 2:** `TesseractOcr` engine (deterministic + confidence) + an engine
router (vision vs tesseract). Per-page timeout.

## Phase 3 — Professional features
- `OcrEngine` interface + pluggable engines (`src/ocr/engines/`).
- Cache by file hash (no re-OCR). Preprocessing (deskew/upscale/contrast via `sharp`).
- `/ocr <path>` command + explicit verbatim vs describe mode.
- Confidence cross-check (Tesseract vs vision).
- **ID/document preset with MRZ validation** — see spec below.

### Spec — ID/passport preset (MRZ ICAO-9303 check-digit validation)

**Problem it solves.** A vision model reads passport fields plausibly but can flip a single
character in dense alphanumerics (passport no., MRZ) *invisibly* — it returns the wrong value
with full confidence. For IDs that's unacceptable. The Machine-Readable Zone (MRZ) carries
**check digits** that let us *verify* the read deterministically, independent of model size.

**The MRZ.** Passports use **TD3**: 2 lines × 44 chars. Line 2 layout:

```
pos   1-9     10   11-13   14-19   20    21    22-27   28    29-42   43    44
field doc.no  CD   nat.    DOB     CD    sex   expiry  CD    pers.   CD    composite-CD
```

Each `CD` is a check digit over the preceding field; pos. 44 validates the whole block.

**Check-digit algorithm.** For a field: map each char to a value (`0-9`→0-9, `A-Z`→10-35,
filler `<`→0), multiply by the repeating weights `7,3,1,7,3,1,…`, sum, take `mod 10`.
Worked example — passport number `AA1940042`:

```
char   A   A   1   9   4   0   0   4   2
value 10  10   1   9   4   0   0   4   2
weight 7   3   1   7   3   1   7   3   1
prod  70  30   1  63  12   0   0  12   2   → sum 190 → 190 mod 10 = 0  → CD must be "0"
```

If OCR misreads one char, the recomputed CD ≠ the printed CD → the error is caught.

**Implementation (zero-install).** Don't reimplement the algorithm — use the `mrz` npm
library (pure JS):

```ts
import { parse } from "mrz";
const result = parse([mrzLine1, mrzLine2]);
//  result.valid    → true only when EVERY check digit passes
//  result.fields   → { documentNumber, nationality, birthDate, expirationDate, sex, ... }
//  result.details  → per-field { field, valid, value, ranges }  ← which field failed
```

**Flow.**
```
preset "ID" active (detected, or /ocr --id)
  → vision model extracts fields AS JSON + the 2 MRZ lines VERBATIM (prompt: "transcribe the
    MRZ, 2 lines of 44 chars, exactly")
  → mrz.parse([l1, l2])  (deterministic)
       ├─ valid:true  → documentNumber / nationality / dates VERIFIED  ✅
       └─ valid:false → flag the failing field → re-OCR / ask for a sharper photo / low confidence
  → cross-check visual fields vs MRZ fields; mismatch → lower confidence
  → return per-field result with ✅ (verified) / ⚠️ (unverified or mismatch)
```

Bonus: **nationality** is in the MRZ (pos. 11-13 = e.g. `ARG`) and issuing country in line 1
(pos. 3-5), so "is it Argentine?" is answered by algorithm, not a visual guess.

**Output shape (sketch).**
```jsonc
{
  "documentType": "passport",
  "mrzValid": true,
  "fields": {
    "passportNumber": { "value": "AA1940042", "verified": true },   // ✅ MRZ check-digit
    "nationality":    { "value": "ARG", "verified": true },
    "dateOfBirth":    { "value": "1978-04-04", "verified": true },
    "expiryDate":     { "value": "2033-04-23", "verified": true },
    "surname":        { "value": "AGUILAR", "verified": false },     // ⚠️ visual only (not in CD scope)
    "givenNames":     { "value": "LUCAS", "verified": false }
  },
  "warnings": []
}
```

**Config / privacy.**
```bash
REI_OCR_PRESET=id            # or auto-detect (TD3 MRZ pattern in the OCR text)
REI_OCR_PERSIST_TEXT=0       # do NOT save extracted text to the session (sensitive PII / IDs)
```
For IDs, prefer the local vision model (image stays on-device); the `mrz` validation is fully
local and deterministic regardless of which model did the read.

**Engine note.** MRZ validation is model-agnostic — it makes a 4B local read *trustworthy*,
and a bigger/cloud VL just lowers how often a check digit fails (fewer re-OCR loops). In a MoE
VL (e.g. qwen3.6-35b-a3b) the vision encoder runs dense, so OCR quality tracks the encoder,
not the active-param count — worth A/B-ing the user's 35b-a3b vs a dedicated qwen2.5-VL-7B.

## Phase 4 — Optional
- Cloud OCR (Textract / Google Vision) for max accuracy on forms/tables.
- Per-task vision presets (`/ocr --model …`) to A/B local vs cloud VL in one command.

## Config / env (introduced across phases)
```bash
# Phase 1 reuses the existing vision envs:
REI_VISION_MODEL / REI_VISION_BASE_URL / REI_VISION_API_KEY
REI_OCR_PDF_MAX_PAGES=30      # (Phase 2) guard for big PDFs
REI_OCR_ENGINE=auto           # (Phase 3) auto | vision | tesseract | cloud
REI_OCR_LANGS=spa+eng         # (Phase 3) Tesseract
REI_OCR_PRESET=id             # (Phase 3) ID/passport preset → MRZ validation (or auto-detect)
REI_OCR_PERSIST_TEXT=1        # (Phase 3) set 0 to NOT save extracted text (sensitive IDs)
REI_OCR_SAVE=0                # 1 = always write full extracted text to <file>.ocr.md
REI_OCR_INLINE_MAX_CHARS=40000  # large docs: save full text to file + inject only a preview
```

### Large documents — extract-to-file (DONE)
An 84-page PDF's text can't fit a local context window. `src/ocr/ocr-output.ts`
`prepareExtractedText()` handles this: when the extracted text exceeds
`REI_OCR_INLINE_MAX_CHARS` (or `REI_OCR_SAVE=1`), the **FULL** text is written to a file and the
prompt gets a **preview + pointer** instead of a silent truncation — so the whole document lives
on disk and is queried in pieces (`@ocr/<file>.ocr.md`) or with a large-window cloud model.
Applies to both digital extraction and scanned-page OCR. **Output stays INSIDE the workspace, in
a VISIBLE folder** — default `<workspace>/ocr/<base>.ocr.md`. It must be visible (not `.rei/`)
because the workspace scanner that powers `@` excludes hidden dirs — so `.rei/ocr` would not be
`@`-referenceable, defeating the purpose. Override with `REI_OCR_OUT_DIR` (absolute, or relative
to the workspace; e.g. `.rei/ocr` if you don't need `@`). *Pending:* page-range ("pp. 20-40").

## Risks
- Vision models are non-deterministic → single-char errors in dense alphanumerics (passport
  no. / MRZ) are invisible without validation → MRZ check-digits (Phase 3) for IDs.
- Big PDFs blow the context/time budget → page guard mandatory once Phase 2 lands.
- Native rendering (pdfjs/poppler) can be awkward per-platform → detection + graceful skip.
- Privacy: local vision keeps sensitive docs (IDs) on-device; cloud VL sends the image out —
  a real accuracy↔privacy tradeoff to surface for ID use.
