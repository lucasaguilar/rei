import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { fetchWithRetry } from "../providers/fetch-retry.js";

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

const DEFAULT_VISION_PROMPT =
  "You are assisting a software engineer. Describe this image precisely and " +
  "objectively. If it is a screenshot of a UI, terminal, code editor, error, or " +
  "diagram, transcribe all visible text verbatim (commands, file paths, error " +
  "messages, labels, code) and describe the layout/structure. Do not speculate " +
  "about anything not visible. Be thorough but factual.";

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
 * Extracts image file paths referenced in the user's input that actually exist on disk.
 * Handles quoted paths, backslash-escaped paths (spaces), bare paths, and @-prefixed
 * paths. Relative paths resolve against the workspace; "~" expands to the home dir.
 * Only existing files are returned, which avoids false positives on arbitrary text.
 */
export function extractImagePaths(text: string, workspacePath: string): string[] {
  const candidates: string[] = [];

  // 1. Quoted paths: '...'  or  "..."
  const quoteRe = /(['"])((?:\\.|(?!\1).)*?)\1/g;
  let m: RegExpExecArray | null;
  while ((m = quoteRe.exec(text)) !== null) {
    if (IMAGE_EXT.test(m[2])) candidates.push(unescapeShellPath(m[2]));
  }

  // 2. Bare or backslash-escaped paths (may contain "\ "), optionally @-prefixed.
  //    Scan the text with quoted segments blanked out to avoid double-matching.
  const stripped = text.replace(quoteRe, " ");
  const bareRe = /@?((?:[^\s'"\\]|\\.)+\.(?:png|jpe?g|webp|gif|bmp))/gi;
  while ((m = bareRe.exec(stripped)) !== null) {
    candidates.push(unescapeShellPath(m[1]));
  }

  // 3. Whole-input fallback: when the user just drags ONE file, the entire input is the
  //    path — and macOS screenshot names can carry UNescaped spaces ("… 6.07.44 p. m..png")
  //    that break the token scan above. Test the full string as a single path too; the
  //    existence check below filters it out if it isn't a real file.
  const whole = unescapeShellPath(text.trim());
  if (IMAGE_EXT.test(whole)) candidates.push(whole);

  // 4. Leading dragged path FOLLOWED by text (and/or with unicode spaces). macOS
  //    screenshot names contain U+202F narrow no-break spaces in the time ("10.48 a. m.")
  //    which terminals do NOT escape, so neither the token scan nor the whole-input
  //    fallback can tell where the path ends and the user's question begins. When the
  //    input starts with an absolute/home path, probe prefixes ending at each image
  //    extension against the filesystem (the disk is the ground truth) and keep the
  //    longest one that exists.
  const head = whole;
  if (head.startsWith("/") || head.startsWith("~")) {
    const extRe = /\.(?:png|jpe?g|webp|gif|bmp)\b/gi;
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

/**
 * Returns true when the user's input is *only* image reference(s) with no accompanying
 * question/instruction (e.g. they just dragged a file and hit enter). In that case the
 * main model needs a default task injected, otherwise it has a description but nothing
 * to do and tends to drift back to the previous topic.
 */
export function isImageOnlyInput(userText: string, workspacePath: string): boolean {
  // Case 1: the entire input is a single existing image path (handles names with
  // unescaped spaces, e.g. macOS screenshots, which the token scan can't bound).
  const whole = expandHome(unescapeShellPath(userText.trim()));
  const abs = path.isAbsolute(whole) ? whole : path.resolve(workspacePath, whole);
  try {
    if (IMAGE_EXT.test(abs) && fs.statSync(abs).isFile()) return true;
  } catch {
    // Not a single path — fall through to the token-strip check.
  }

  // Case 2: strip quoted / bare / escaped image-path tokens and any path separators;
  // if no real words remain, it was just (possibly multiple) image references.
  const stripped = userText
    .replace(/(['"])((?:\\.|(?!\1).)*?)\1/g, " ")
    .replace(/@?(?:[^\s'"\\]|\\.)+\.(?:png|jpe?g|webp|gif|bmp)/gi, " ")
    .replace(/[\\/]/g, " ");
  return !/[a-zA-Z]{2,}/.test(stripped);
}

/**
 * Sends a single image to the configured vision model and returns its text description.
 * Uses the OpenAI-compatible chat/completions endpoint with an inline base64 data URL.
 */
export async function describeImage(
  imagePath: string,
  opts?: { prompt?: string; config?: VisionConfig; timeoutMs?: number },
): Promise<string> {
  const config = opts?.config ?? getVisionConfig();
  if (!config) {
    throw new Error(
      "No vision model configured. Set REI_VISION_MODEL (or LLM_STUDIO_MODEL).",
    );
  }

  const mime = imageMimeType(imagePath);
  if (!mime) {
    throw new Error(`Unsupported image type: ${path.basename(imagePath)}`);
  }

  const base64 = (await fs.promises.readFile(imagePath)).toString("base64");
  const dataUrl = `data:${mime};base64,${base64}`;
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
  /** The user's original text plus the appended visual description(s). */
  augmentedPrompt: string;
  /** Per-image results that succeeded. */
  images: Array<{ path: string; description: string }>;
}

/**
 * Detects images attached in the user's input, describes each via the vision sidecar,
 * and returns the original prompt augmented with their text descriptions.
 *
 * Returns null when there are no images, no vision model is configured, or every
 * image failed — callers then proceed with the unmodified prompt. Progress/errors
 * are surfaced via the optional onStatus callback.
 */
export async function describeAttachedImages(
  userText: string,
  workspacePath: string,
  onStatus?: (message: string) => void,
): Promise<VisionAugmentation | null> {
  const paths = extractImagePaths(userText, workspacePath);
  if (paths.length === 0) return null;

  const config = getVisionConfig();
  if (!config) {
    onStatus?.(
      `⚠️  Detected ${paths.length} image(s) but no vision model is configured ` +
        `(set REI_VISION_MODEL). Skipping visual analysis.`,
    );
    return null;
  }

  const images: Array<{ path: string; description: string }> = [];
  for (const imagePath of paths) {
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

  if (images.length === 0) return null;

  const sections = images
    .map((img) => `--- Image: ${img.path} ---\n${img.description}`)
    .join("\n\n");

  // If the user only attached image(s) with no question, give the model an explicit
  // task so it acts on this turn instead of drifting back to the prior topic.
  const imageOnly = isImageOnlyInput(userText, workspacePath);
  const augmentedPrompt = imageOnly
    ? `[The user attached the image(s) below with no other text. A vision model ` +
      `(${config.model}) produced the description(s). Summarize what the image shows ` +
      `and any details relevant to the project, then ask what they'd like to do with ` +
      `it.]\n\n${sections}`
    : `${userText}\n\n` +
      `[Visual context — the user attached image(s); a vision model (${config.model}) ` +
      `produced the description(s) below. Treat them as a faithful account of what the ` +
      `image(s) show.]\n\n${sections}`;

  return { augmentedPrompt, images };
}
