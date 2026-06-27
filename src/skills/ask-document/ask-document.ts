import * as fs from "node:fs";
import type { ModelProvider } from "../../providers/model-provider.js";
import { indexDocument } from "./indexer.js";
import { retrieve } from "./retriever.js";
import { buildGroundedMessages, parseGroundedResponse } from "./prompt.js";
import { verifyQuote } from "./verify.js";
import type { AskResult, Claim } from "./types.js";

function intEnv(name: string, fallback: number): number {
  const n = parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Grounded Q&A over a document with VERIFIED citations.
 *   index → retrieve top-k → answer ONLY from those excerpts (cite page + verbatim quote) →
 *   deterministically verify each quote against the source (✅ found / ⚠️ fabricated) → result.
 * Fabricated claims (quotes not actually in the text) are flagged, not trusted — this is what
 * keeps the model from hallucinating.
 */
export async function askDocument(params: {
  filePath: string;
  question: string;
  provider: ModelProvider;
  workspacePath: string;
  k?: number;
  onStatus?: (message: string) => void;
}): Promise<AskResult> {
  const { filePath, question, provider, workspacePath, onStatus } = params;
  const k = params.k ?? intEnv("REI_DOC_RETRIEVE_K", 6);

  // Full source text — used to verify quotes against (a quote may span a retrieved chunk).
  const source = await fs.promises.readFile(filePath, "utf-8");

  const index = await indexDocument(filePath, workspacePath, onStatus);
  const top = await retrieve(index, question, k);
  if (top.length === 0) {
    return {
      answer: "The document index is empty — nothing to search.",
      claims: [],
      faithfulness: { verified: 0, total: 0 },
      notFound: true,
      sources: [],
    };
  }

  onStatus?.(`🔎 Retrieved ${top.length} passages (pages ${[...new Set(top.map((c) => c.page))].join(", ")})…`);

  // reasoningEffort:none — the grounded answer is STRUCTURED JSON; the model's <think> phase just
  // eats the output-token budget and risks truncating the JSON mid-object (→ parse fails). Off is
  // faster and keeps the whole cap for the answer + citations.
  const response = await provider.completeChat(buildGroundedMessages(question, top), {
    reasoningEffort: "none",
  });
  const parsed = parseGroundedResponse(response);

  // Deterministic faithfulness check: verify each claim's quote actually exists in the source.
  const verifyEnabled = process.env.REI_DOC_VERIFY !== "0";
  const claims: Claim[] = parsed.claims.map((c) => ({
    text: c.text,
    page: c.page,
    quote: c.quote,
    status: !verifyEnabled
      ? "verified"
      : c.quote
        ? verifyQuote(c.quote, source)
        : "fabricated",
  }));

  const verified = claims.filter((c) => c.status !== "fabricated").length;
  const sources = [...new Set(top.map((c) => c.page))].sort((a, b) => a - b);

  return {
    answer: parsed.answer,
    claims,
    faithfulness: { verified, total: claims.length },
    notFound: parsed.notFound,
    sources,
  };
}
