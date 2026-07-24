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

  // Fallback rescues the "answer" field from a truncated JSON, else shows the (think-stripped)
  // prose. NEVER fall back to the raw `response` — when a reasoning model burns its whole budget on
  // <think> and returns no answer, `cleaned` is empty and `|| response` would dump the ENTIRE
  // reasoning block to screen (observed: 19.8k chars of <think> shown as the "answer"). Instead,
  // report that nothing usable came back.
  const rescued = (extractAnswerField(cleaned) ?? cleaned).trim();
  const fallbackClaims = extractClaimsFallback(cleaned);
  const fallback: ParsedGrounded = {
    answer:
      rescued ||
      "(El modelo no devolvió una respuesta: el razonamiento consumió toda la salida. " +
        "Reintentá, o desactivá el thinking del modelo.)",
    claims: fallbackClaims,
    notFound: rescued.length === 0,
  };
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end <= start) return fallback;

  const rawJsonStr = cleaned.slice(start, end + 1);
  const parsedObj = tryParseJson(rawJsonStr);
  if (parsedObj) {
    const obj = parsedObj as Record<string, unknown>;
    const rawClaims = Array.isArray(obj.claims)
      ? obj.claims
          .filter((c: unknown) => c && typeof c === "object")
          .map((c: { text?: unknown; page?: unknown; quote?: unknown }) => ({
            text: typeof c.text === "string" ? c.text : "",
            page: typeof c.page === "number" ? c.page : undefined,
            quote: typeof c.quote === "string" ? c.quote : undefined,
          }))
      : fallbackClaims;
    const claims = dedupeClaims(rawClaims.length > 0 ? rawClaims : fallbackClaims);
    return {
      answer: typeof obj.answer === "string" ? obj.answer : fallback.answer,
      claims,
      notFound: obj.notFound === true,
    };
  }

  return {
    ...fallback,
    claims: dedupeClaims(fallback.claims),
  };
}

/** Deduplicates claims that cite the exact same quote/text on the same page. */
function dedupeClaims<T extends { text?: string; page?: number; quote?: string }>(claims: T[]): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const c of claims) {
    const content = (c.quote || c.text || "").trim().toLowerCase().replace(/\s+/g, " ");
    if (!content) continue;
    const key = `${c.page ?? ""}:${content}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(c);
    }
  }
  return result;
}


/** Attempts standard JSON.parse, followed by common repair strategies (trailing commas, unescaped newlines). */
function tryParseJson(jsonStr: string): unknown {
  try {
    return JSON.parse(jsonStr);
  } catch {
    try {
      // Fix trailing commas before } or ]
      const fixedCommas = jsonStr.replace(/,\s*([}\]])/g, "$1");
      return JSON.parse(fixedCommas);
    } catch {
      try {
        // Fix literal unescaped newlines in JSON strings
        const fixedNewlines = jsonStr.replace(/([^\\])\r?\n/g, "$1\\n");
        return JSON.parse(fixedNewlines);
      } catch {
        return null;
      }
    }
  }
}

/** Best-effort extraction of claims using regex when JSON.parse fails on malformed/truncated output. */
function extractClaimsFallback(text: string): Array<{ text: string; page?: number; quote?: string }> {
  const claims: Array<{ text: string; page?: number; quote?: string }> = [];
  const claimsIdx = text.indexOf('"claims"');
  const targetText = claimsIdx !== -1 ? text.slice(claimsIdx) : text;

  const objRegex = /\{[^{}]*?\}/g;
  let match: RegExpExecArray | null;
  while ((match = objRegex.exec(targetText)) !== null) {
    const block = match[0];
    const textM = block.match(/"text"\s*:\s*"((?:\\.|[^"\\])*)"/i);
    const pageM = block.match(/"page"\s*:\s*(\d+)/i);
    const quoteM = block.match(/"quote"\s*:\s*"((?:\\.|[^"\\])*)"/i);
    if (textM || quoteM) {
      claims.push({
        text: textM ? textM[1].replace(/\\"/g, '"') : "",
        page: pageM ? parseInt(pageM[1], 10) : undefined,
        quote: quoteM ? quoteM[1].replace(/\\"/g, '"') : undefined,
      });
    }
  }
  return claims;
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

