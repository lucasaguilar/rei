import type { ChatMessage } from "../../chat/types.js";
import type { RetrievedChunk } from "./retriever.js";

/**
 * Builds the grounded-answer messages: the model may use ONLY the retrieved excerpts, must cite
 * a page + verbatim quote per claim, and must refuse when the answer isn't present. The strict
 * JSON shape lets us deterministically verify each quote afterwards.
 */
export function buildGroundedMessages(
  question: string,
  chunks: RetrievedChunk[],
): ChatMessage[] {
  const excerpts = chunks
    .map((c, i) => `[Excerpt ${i + 1} | page ${c.page}]\n${c.text}`)
    .join("\n\n");

  const system =
    "You answer questions about a document using ONLY the excerpts provided by the user. " +
    "You must not use any outside knowledge. Return STRICT JSON and nothing else, with this shape:\n" +
    '{ "answer": string, "claims": [{ "text": string, "page": number, "quote": string }], "notFound": boolean }\n' +
    "Rules:\n" +
    "- Use ONLY the excerpts. If they do not contain the answer, set notFound=true, say so in " +
    "answer, and return claims=[].\n" +
    "- For EVERY claim in your answer, include the page it came from and a VERBATIM quote — copy " +
    "the exact words from the excerpt, do NOT paraphrase inside \"quote\".\n" +
    "- Each \"quote\" MUST be ONE COMPLETE SENTENCE copied exactly: start at the beginning of the " +
    "sentence and end at its period. NEVER cut a sentence mid-word or mid-phrase, and never use " +
    "ellipses (…) to trim it. Pick the single most relevant complete sentence.\n" +
    "- Answer in the user's language.";

  const user =
    `Excerpts:\n\n${excerpts}\n\n---\nQuestion: ${question}\n\nReturn ONLY the JSON object.`;

  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

export interface ParsedGrounded {
  answer: string;
  claims: Array<{ text: string; page?: number; quote?: string }>;
  notFound: boolean;
}

/** Robustly extracts the JSON object from the model's response (tolerates fences / stray prose). */
export function parseGroundedResponse(response: string): ParsedGrounded {
  // Strip reasoning blocks FIRST — a thinking model (qwen3.6 …) emits <think>…</think> that
  // often contains DRAFT JSON, which would break the naive first-{ / last-} extraction below.
  const cleaned = response
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<think>[\s\S]*$/i, "")
    .trim();

  // Fallback already tries to rescue the "answer" field, so a truncated JSON with NO closing
  // brace (early-return path) still shows prose instead of raw JSON.
  const fallback: ParsedGrounded = {
    answer: extractAnswerField(cleaned) ?? (cleaned || response).trim(),
    claims: [],
    notFound: false,
  };
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end <= start) return fallback;
  try {
    const obj = JSON.parse(cleaned.slice(start, end + 1));
    return {
      answer: typeof obj.answer === "string" ? obj.answer : fallback.answer,
      claims: Array.isArray(obj.claims)
        ? obj.claims
            .filter((c: unknown) => c && typeof c === "object")
            .map((c: { text?: unknown; page?: unknown; quote?: unknown }) => ({
              text: typeof c.text === "string" ? c.text : "",
              page: typeof c.page === "number" ? c.page : undefined,
              quote: typeof c.quote === "string" ? c.quote : undefined,
            }))
        : [],
      notFound: obj.notFound === true,
    };
  } catch {
    // Truncated/invalid JSON: fallback already rescued the "answer" string (claims dropped —
    // can't verify a partial), so the user sees prose, not raw JSON.
    return fallback;
  }
}

/** Best-effort extraction of the "answer" string from malformed/truncated grounded JSON. */
function extractAnswerField(text: string): string | undefined {
  const m = text.match(/"answer"\s*:\s*"((?:\\.|[^"\\])*)"/);
  if (!m) return undefined;
  try {
    return JSON.parse(`"${m[1]}"`);
  } catch {
    return m[1];
  }
}
