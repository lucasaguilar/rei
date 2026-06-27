import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { fetchWithRetry } from "../providers/fetch-retry.js";
import { extractPdfText } from "../ocr/pdf-text.js";
import { renderPdfPages } from "../ocr/pdf-render.js";
import { prepareExtractedText } from "../ocr/ocr-output.js";

/**
 * Vision sidecar (Phase 1).
 *
 * Decoupled image→text service: when the user attaches an image (by dragging a file
 * into the terminal, which pastes its path, or by typing the path / @path), we send
 * that image to a vision-capable model in a SEPARATE backend call and inject the
 * returned text description into the main agent loop as context.
 *
 * Why a sidecar instead of inline multimodal content:
 * - the reasoning/coding model stays text-only (or cloud) — vision is decoupled;
 * - the whole pipeline stays `string`-based (no `ContentPart[]` threading);
 * - we persist the text description, never the base64 blob;
 * - it works cross-provider (vision local, reasoning anywhere).
 *
 * Trade-off: lossy — a caption may miss exact UI text / pixel coords / colors.
 * Inline multimodal (Phase 2) can be layered on top for fidelity-critical cases.
 */

const IMAGE_EXT = /\.(png|jpe?g|webp|gif|bmp)$/i;
// Regex alternations reused to build the path-detection patterns per attachment kind.
const IMAGE_EXT_ALT = "png|jpe?g|webp|gif|bmp";
const PDF_EXT_ALT = "pdf";
// Any OCR-able attachment (images + pdf) — used for the "attachment-only input" check.
const ATTACH_EXT = /\.(png|jpe?g|webp|gif|bmp|pdf)$/i;

const DEFAULT_VISION_PROMPT =
  "You are an OCR and visual-analysis assistant. Transcribe ALL visible text VERBATIM " +
  "(do not paraphrase, translate, or omit) and preserve the structure in markdown: use " +
  "headings and lists, and render any tables as GitHub markdown tables. For a screenshot " +
  "of a UI, terminal, code editor, error, or diagram, also describe the layout/structure. " +
  "For a form, ID document, invoice, or receipt, extract every field with its label. Do " +
  "not speculate about anything not visible. Be exhaustive and factual.";

const DEFAULT_VISION_TIMEOUT_MS = 120_000;

export interface VisionConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

/**
 * Resolves the vision-model config from env. Returns null when no vision model is
 * configured, so callers can skip cleanly instead of firing a doomed request.
 * Defaults target a local LM Studio server.
 */
export function getVisionConfig(): VisionConfig | null {
  const model = (
    process.env.REI_VISION_MODEL ||
    process.env.LLM_STUDIO_MODEL ||
    ""
  ).trim();
  if (!model) return null;

  const baseUrl = (
    process.env.REI_VISION_BASE_URL ||
    process.env.LLM_STUDIO_BASE_URL ||
    "http://localhost:1234/v1"
  ).replace(/\/+$/, "");

  const apiKey =
    process.env.REI_VISION_API_KEY ||
    process.env.LLM_STUDIO_API_KEY ||
    "lm-studio";

  return { baseUrl, apiKey, model };
}

/** Maps a file extension to its image MIME type, or undefined if unsupported. */
export function imageMimeType(filePath: string): string | undefined {
  switch (path.extname(filePath).toLowerCase()) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    case ".bmp":
      return "image/bmp";
    default:
      return undefined;
  }
}

function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

/** Resolves a candidate against the workspace/home and returns the abs path if it's an existing file. */
function resolveExistingFile(
  candidate: string,
  workspacePath: string,
): string | null {
  const expanded = expandHome(candidate);
  const abs = path.isAbsolute(expanded)
    ? expanded
    : path.resolve(workspacePath, expanded);
  try {
    if (fs.statSync(abs).isFile()) return abs;
  } catch {
    /* not a real file */
  }
  return null;
}

/**
 * Unescapes shell-style backslash escapes that a terminal inserts when you drag a
 * file whose path contains spaces (e.g. "Captura\ de\ pantalla.png" -> "Captura de pantalla.png").
 */
function unescapeShellPath(p: string): string {
  return p.replace(/\\(.)/g, "$1");
}

/**
 * Generalized path detection shared by images and PDFs. `extAlt` is a regex alternation of
 * extensions (e.g. "png|jpe?g|webp|gif|bmp" or "pdf"). Handles quoted, backslash-escaped
 * (spaces), bare, @-prefixed, whole-input, and leading-path-then-text (macOS unicode-space)
 * cases. Relative paths resolve against the workspace; "~" expands to home. Only paths that
 * exist on disk are returned, avoiding false positives on arbitrary text.
 */
export function extractFilePaths(
  text: string,
  workspacePath: string,
  extAlt: string,
): string[] {
  const fullExt = new RegExp(`\\.(?:${extAlt})$`, "i");
  const bareRe = new RegExp(`@?((?:[^\\s'"\\\\]|\\\\.)+\\.(?:${extAlt}))`, "gi");
  const extRe = new RegExp(`\\.(?:${extAlt})\\b`, "gi");

  const candidates: string[] = [];

  // 1. Quoted paths: '...'  or  "..."
  const quoteRe = /(['"])((?:\\.|(?!\1).)*?)\1/g;
  let m: RegExpExecArray | null;
  while ((m = quoteRe.exec(text)) !== null) {
    if (fullExt.test(m[2])) candidates.push(unescapeShellPath(m[2]));
  }

  // 2. Bare or backslash-escaped paths (may contain "\ "), optionally @-prefixed.
  //    Scan the text with quoted segments blanked out to avoid double-matching.
  const stripped = text.replace(quoteRe, " ");
  while ((m = bareRe.exec(stripped)) !== null) {
    candidates.push(unescapeShellPath(m[1]));
  }

  // 3. Whole-input fallback: when the user just drags ONE file, the entire input is the
  //    path — and macOS screenshot names can carry UNescaped spaces ("… 6.07.44 p. m..png")
  //    that break the token scan above. Test the full string as a single path too; the
  //    existence check below filters it out if it isn't a real file.
  const whole = unescapeShellPath(text.trim());
  if (fullExt.test(whole)) candidates.push(whole);

  // 4. Leading dragged path FOLLOWED by text (and/or with unicode spaces). macOS
  //    screenshot names contain U+202F narrow no-break spaces in the time ("10.48 a. m.")
  //    which terminals do NOT escape, so neither the token scan nor the whole-input
  //    fallback can tell where the path ends and the user's question begins. When the
  //    input starts with an absolute/home path, probe prefixes ending at each
  //    extension against the filesystem (the disk is the ground truth) and keep the
  //    longest one that exists.
  const head = whole;
  if (head.startsWith("/") || head.startsWith("~")) {
    let extMatch: RegExpExecArray | null;
    let longestExisting: string | null = null;
    while ((extMatch = extRe.exec(head)) !== null) {
      const candidate = head.slice(0, extMatch.index + extMatch[0].length);
      if (resolveExistingFile(candidate, workspacePath)) longestExisting = candidate;
    }
    if (longestExisting) candidates.push(longestExisting);
  }

  const resolved: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const expanded = expandHome(candidate);
    const abs = path.isAbsolute(expanded)
      ? expanded
      : path.resolve(workspacePath, expanded);
    if (seen.has(abs)) continue;
    seen.add(abs);
    try {
      if (fs.statSync(abs).isFile()) resolved.push(abs);
    } catch {
      // Not a real file — skip silently (avoids false positives on plain text).
    }
  }
  return resolved;
}

/** Image paths (png/jpg/webp/gif/bmp) referenced in the input that exist on disk. */
export function extractImagePaths(text: string, workspacePath: string): string[] {
  return extractFilePaths(text, workspacePath, IMAGE_EXT_ALT);
}

/** PDF paths referenced in the input that exist on disk. */
export function extractPdfPaths(text: string, workspacePath: string): string[] {
  return extractFilePaths(text, workspacePath, PDF_EXT_ALT);
}

/**
 * Returns true when the user's input is *only* image reference(s) with no accompanying
 * question/instruction (e.g. they just dragged a file and hit enter). In that case the
 * main model needs a default task injected, otherwise it has a description but nothing
 * to do and tends to drift back to the previous topic.
 */
function onlyAttachmentInput(
  userText: string,
  workspacePath: string,
  extTest: RegExp,
  extAlt: string,
): boolean {
  // Case 1: the entire input is a single existing attachment path (handles names with
  // unescaped spaces, e.g. macOS screenshots, which the token scan can't bound).
  const whole = expandHome(unescapeShellPath(userText.trim()));
  const abs = path.isAbsolute(whole) ? whole : path.resolve(workspacePath, whole);
  try {
    if (extTest.test(abs) && fs.statSync(abs).isFile()) return true;
  } catch {
    // Not a single path — fall through to the token-strip check.
  }

  // Case 2: strip quoted / bare / escaped attachment-path tokens and any path separators;
  // if no real words remain, it was just (possibly multiple) attachment references.
  const stripped = userText
    .replace(/(['"])((?:\\.|(?!\1).)*?)\1/g, " ")
    .replace(new RegExp(`@?(?:[^\\s'"\\\\]|\\\\.)+\\.(?:${extAlt})`, "gi"), " ")
    .replace(/[\\/]/g, " ");
  return !/[a-zA-Z]{2,}/.test(stripped);
}

export function isImageOnlyInput(userText: string, workspacePath: string): boolean {
  return onlyAttachmentInput(userText, workspacePath, IMAGE_EXT, IMAGE_EXT_ALT);
}

/** True when the input is only image/PDF attachment reference(s) with no question. */
export function isAttachmentOnlyInput(
  userText: string,
  workspacePath: string,
): boolean {
  return onlyAttachmentInput(
    userText,
    workspacePath,
    ATTACH_EXT,
    `${IMAGE_EXT_ALT}|${PDF_EXT_ALT}`,
  );
}

/**
 * Sends a single image to the configured vision model and returns its text description.
 * Reads the file, builds an inline base64 data URL, and delegates to describeImageDataUrl.
 */
export async function describeImage(
  imagePath: string,
  opts?: { prompt?: string; config?: VisionConfig; timeoutMs?: number },
): Promise<string> {
  const mime = imageMimeType(imagePath);
  if (!mime) {
    throw new Error(`Unsupported image type: ${path.basename(imagePath)}`);
  }
  const base64 = (await fs.promises.readFile(imagePath)).toString("base64");
  return describeImageDataUrl(`data:${mime};base64,${base64}`, opts);
}

/**
 * Sends an inline base64 image data URL to the configured vision model and returns its text.
 * Uses the OpenAI-compatible chat/completions endpoint. Exposed so callers that already have
 * an in-memory image (e.g. rendered PDF pages) can OCR it without writing a temp file.
 */
export async function describeImageDataUrl(
  dataUrl: string,
  opts?: { prompt?: string; config?: VisionConfig; timeoutMs?: number },
): Promise<string> {
  const config = opts?.config ?? getVisionConfig();
  if (!config) {
    throw new Error(
      "No vision model configured. Set REI_VISION_MODEL (or LLM_STUDIO_MODEL).",
    );
  }

  const prompt = opts?.prompt ?? DEFAULT_VISION_PROMPT;

  const res = await fetchWithRetry(
    `${config.baseUrl}/chat/completions`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              { type: "image_url", image_url: { url: dataUrl } },
            ],
          },
        ],
        temperature: 0.2,
        stream: false,
      }),
    },
    { timeoutMs: opts?.timeoutMs ?? DEFAULT_VISION_TIMEOUT_MS },
  );

  if (!res.ok) {
    const details = await res.text().catch(() => "");
    throw new Error(
      `Vision request failed (${res.status} ${res.statusText})` +
        (details ? `: ${details.slice(0, 200)}` : ""),
    );
  }

  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: string | null } }>;
    error?: { message?: string };
  };
  if (json.error) {
    throw new Error(`Vision model error: ${json.error.message ?? "unknown"}`);
  }

  const content = json.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    throw new Error("Vision model returned empty content.");
  }
  return content.trim();
}

export interface VisionAugmentation {
  /** The user's original text plus the appended visual description(s) and/or PDF text. */
  augmentedPrompt: string;
  /** Per-image results that succeeded. */
  images: Array<{ path: string; description: string }>;
  /** Per-PDF text extractions (digital → text layer; scanned → page-by-page vision OCR). */
  documents: Array<{ path: string; text: string; pages: number }>;
}

/**
 * Renders a scanned PDF's pages to images (pdf-parse getScreenshot) and OCRs each via the
 * vision model, returning the combined text with `--- Page N ---` markers. The page budget
 * (REI_OCR_PDF_MAX_PAGES) bounds the number of vision calls; a truncation note is appended.
 */
async function ocrScannedPdf(
  pdfPath: string,
  config: VisionConfig,
  name: string,
  onStatus?: (message: string) => void,
): Promise<{ text: string; pages: number }> {
  const render = await renderPdfPages(pdfPath);
  const parts: string[] = [];
  for (const pg of render.pages) {
    onStatus?.(
      `🔎 OCR page ${pg.pageNumber}/${render.pages.length} of ${name} with ${config.model}…`,
    );
    try {
      const text = await describeImageDataUrl(pg.dataUrl, { config });
      parts.push(`--- Page ${pg.pageNumber} ---\n${text}`);
    } catch (err) {
      onStatus?.(
        `⚠️  OCR failed on page ${pg.pageNumber} of ${name}: ` +
          (err instanceof Error ? err.message : String(err)),
      );
    }
  }
  if (render.truncated) {
    parts.push(
      `[Note: only the first ${render.pages.length} of ${render.total} pages were OCR'd ` +
        `(REI_OCR_PDF_MAX_PAGES). Raise it to process more.]`,
    );
  }
  return { text: parts.join("\n\n"), pages: render.total };
}

/**
 * Detects images AND PDFs attached in the user's input, extracts their text (images via the
 * vision sidecar/OCR, digital PDFs via pdf-parse, scanned PDFs via page-render + vision OCR),
 * and returns the prompt augmented with it.
 *
 * Returns null when there are no attachments, or every attachment failed — callers then
 * proceed with the unmodified prompt. Progress/errors are surfaced via the optional onStatus
 * callback. (Name kept for the established call site; it now handles documents too.)
 */
export async function describeAttachedImages(
  userText: string,
  workspacePath: string,
  onStatus?: (message: string) => void,
): Promise<VisionAugmentation | null> {
  const imagePaths = extractImagePaths(userText, workspacePath);
  const pdfPaths = extractPdfPaths(userText, workspacePath);
  if (imagePaths.length === 0 && pdfPaths.length === 0) return null;

  const config = getVisionConfig();

  // --- PDFs: digital → text layer (pdf-parse); scanned → render pages → OCR via vision. ---
  const documents: Array<{ path: string; text: string; pages: number }> = [];
  for (const pdfPath of pdfPaths) {
    const name = path.basename(pdfPath);
    onStatus?.(`📄 Reading ${name}…`);
    try {
      const res = await extractPdfText(pdfPath);
      if (res.hasTextLayer) {
        const prepared = await prepareExtractedText(pdfPath, res.text, res.pages);
        if (prepared.savedPath) {
          onStatus?.(
            `💾 ${prepared.truncated ? `${name} is large (${res.pages} pages) — full text` : "Full text"} ` +
              `saved → ${prepared.savedPath}`,
          );
        }
        documents.push({ path: pdfPath, text: prepared.inject, pages: res.pages });
      } else if (config) {
        // No text layer → scanned: rasterize pages and OCR each with the vision model.
        onStatus?.(`🧾 ${name} looks scanned — rendering pages for OCR…`);
        const ocr = await ocrScannedPdf(pdfPath, config, name, onStatus);
        if (ocr.text) {
          const prepared = await prepareExtractedText(pdfPath, ocr.text, ocr.pages);
          if (prepared.savedPath) {
            onStatus?.(
              `💾 ${prepared.truncated ? "Large doc — full OCR" : "Full OCR"} saved → ${prepared.savedPath}`,
            );
          }
          documents.push({ path: pdfPath, text: prepared.inject, pages: ocr.pages });
        } else onStatus?.(`⚠️  Could not OCR any page of ${name}.`);
      } else {
        onStatus?.(
          `⚠️  ${name} is scanned (no text layer) and no vision model is configured ` +
            `(set REI_VISION_MODEL) to OCR it.`,
        );
      }
    } catch (err) {
      onStatus?.(
        `⚠️  Could not read ${name}: ` +
          (err instanceof Error ? err.message : String(err)),
      );
    }
  }

  // --- Images: transcribe/describe via the vision model. ---
  const images: Array<{ path: string; description: string }> = [];
  if (imagePaths.length > 0) {
    if (!config) {
      onStatus?.(
        `⚠️  Detected ${imagePaths.length} image(s) but no vision model is configured ` +
          `(set REI_VISION_MODEL). Skipping visual analysis.`,
      );
    } else {
      for (const imagePath of imagePaths) {
        onStatus?.(`🖼️  Analyzing ${path.basename(imagePath)} with ${config.model}…`);
        try {
          const description = await describeImage(imagePath, { config });
          images.push({ path: imagePath, description });
        } catch (err) {
          onStatus?.(
            `⚠️  Could not analyze ${path.basename(imagePath)}: ` +
              (err instanceof Error ? err.message : String(err)),
          );
        }
      }
    }
  }

  if (images.length === 0 && documents.length === 0) return null;

  const imageSections = images.map(
    (img) => `--- Image: ${img.path} ---\n${img.description}`,
  );
  const docSections = documents.map(
    (d) => `--- PDF: ${d.path} (${d.pages} page${d.pages === 1 ? "" : "s"}) ---\n${d.text}`,
  );
  const sections = [...imageSections, ...docSections].join("\n\n");

  // If the user only attached file(s) with no question, give the model an explicit task so
  // it acts on this turn instead of drifting back to the prior topic.
  const attachmentOnly = isAttachmentOnlyInput(userText, workspacePath);
  const augmentedPrompt = attachmentOnly
    ? `[The user attached the document(s)/image(s) below with no other text. The text was ` +
      `extracted via OCR / PDF parsing. Summarize the content and any relevant details, then ` +
      `ask what they'd like to do with it.]\n\n${sections}`
    : `${userText}\n\n` +
      `[Attached context — the user referenced the document(s)/image(s) below; the text was ` +
      `extracted via OCR / PDF parsing. Treat it as a faithful transcription.]\n\n${sections}`;

  return { augmentedPrompt, images, documents };
}
