import { estimateTokens } from "../chat/helpers/token-estimator.js";
import type { ChatMessage } from "../chat/types.js";
import type { TurnContext } from "./context-builder.js";

/** Tokens reserved for the repo map fragment injected into the user message. */
const REPO_MAP_BUFFER = 2000;
/** Message formatting, role prefixes, separators, etc. */
const OVERHEAD_BUFFER = 600;

/**
 * Calculates how many tokens are available for the dynamic context portion
 * (RAG snippets, file previews, caller files, external knowledge) of a turn.
 *
 * Formula:
 *   budget = numCtx - systemPrompt - sessionHistory - userInput
 *            - responseReserve - repoMapBuffer - overheadBuffer
 *
 * Returns undefined when numCtx is 0/unknown (no trimming applied).
 */
export function calculateContextBudget(params: {
  numCtx: number;
  systemPrompt: string;
  history: ChatMessage[];
  userInput: string;
  responseReserve: number;
}): number | undefined {
  const { numCtx, systemPrompt, history, userInput, responseReserve } = params;
  if (!numCtx || numCtx <= 0) return undefined;

  const consumed =
    estimateTokens(systemPrompt) +
    history.reduce((acc, m) => acc + estimateTokens(m.content), 0) +
    estimateTokens(userInput) +
    responseReserve +
    REPO_MAP_BUFFER +
    OVERHEAD_BUFFER;

  const available = numCtx - consumed;
  // Always leave at least 500 tokens for context — prevents complete starvation
  return Math.max(500, available);
}

/** Estimates the token cost of the variable parts of a TurnContext. */
function estimateContextTokens(ctx: TurnContext): number {
  let total = estimateTokens(ctx.repoSummary);
  total += ctx.relevantFiles.reduce((s, f) => s + estimateTokens(f.preview), 0);
  total += (ctx.ragNodeSnippets ?? []).reduce((s, n) => s + estimateTokens(n.code), 0);
  total += (ctx.callerFiles ?? []).reduce((s, f) => s + estimateTokens(f.preview), 0);
  total += ctx.externalKnowledge.reduce(
    (s, k) => s + estimateTokens(k.content + (k.title ?? "")),
    0,
  );
  return total;
}

/**
 * Progressively trims a TurnContext to fit within the token budget.
 * Trimming order (most expendable first):
 *   1. External knowledge  — web data, rarely critical
 *   2. Caller graph files  — agent can re-request via read_files
 *   3. RAG node snippets   — trim from lowest-score tail
 *   4. Relevant files      — trim from lowest-score tail
 *   5. Truncate previews   — at 50% then 25% of original
 *   6. Remove all previews — last resort, keeps repo summary only
 *
 * Returns { context, trimmed } where trimmed=true signals that something was cut.
 */
export function trimContextToBudget(
  ctx: TurnContext,
  budget: number,
): { context: TurnContext; trimmed: boolean } {
  let result: TurnContext = {
    ...ctx,
    relevantFiles: [...ctx.relevantFiles],
    ragNodeSnippets: ctx.ragNodeSnippets ? [...ctx.ragNodeSnippets] : undefined,
    callerFiles: ctx.callerFiles ? [...ctx.callerFiles] : undefined,
    externalKnowledge: [...ctx.externalKnowledge],
  };

  if (estimateContextTokens(result) <= budget) {
    return { context: result, trimmed: false };
  }

  // ── Step 1: drop external knowledge ──────────────────────────────────────
  if (result.externalKnowledge.length > 0) {
    result.externalKnowledge = [];
    if (estimateContextTokens(result) <= budget) {
      return { context: result, trimmed: true };
    }
  }

  // ── Step 2: drop caller files ─────────────────────────────────────────────
  if (result.callerFiles && result.callerFiles.length > 0) {
    result.callerFiles = undefined;
    if (estimateContextTokens(result) <= budget) {
      return { context: result, trimmed: true };
    }
  }

  // ── Step 3: trim RAG snippets from the tail (lowest-ranked last) ──────────
  while ((result.ragNodeSnippets?.length ?? 0) > 1) {
    result.ragNodeSnippets = result.ragNodeSnippets!.slice(0, -1);
    if (estimateContextTokens(result) <= budget) {
      return { context: result, trimmed: true };
    }
  }

  // ── Step 4: trim relevant files from the tail (lowest-scored last) ────────
  while (result.relevantFiles.length > 1) {
    result.relevantFiles = result.relevantFiles.slice(0, -1);
    if (estimateContextTokens(result) <= budget) {
      return { context: result, trimmed: true };
    }
  }

  // ── Step 5: truncate previews to progressively smaller fractions ──────────
  const truncateAll = (fraction: number): void => {
    result.relevantFiles = result.relevantFiles.map((f) => {
      const maxChars = Math.floor(f.preview.length * fraction);
      if (maxChars >= f.preview.length) return f;
      return {
        ...f,
        preview:
          f.preview.slice(0, maxChars) +
          "\n... (truncated — context budget exceeded)",
      };
    });

    if (result.ragNodeSnippets && result.ragNodeSnippets.length > 0) {
      result.ragNodeSnippets = result.ragNodeSnippets.map((s) => {
        const maxChars = Math.floor(s.code.length * fraction);
        if (maxChars >= s.code.length) return s;
        return {
          ...s,
          code:
            s.code.slice(0, maxChars) +
            "\n// ... (truncated — context budget exceeded)",
        };
      });
    }
  };

  for (const fraction of [0.5, 0.25]) {
    truncateAll(fraction);
    if (estimateContextTokens(result) <= budget) {
      return { context: result, trimmed: true };
    }
  }

  // ── Step 6: last resort — drop all file previews, keep only repo summary ──
  result.relevantFiles = [];
  result.ragNodeSnippets = undefined;
  return { context: result, trimmed: true };
}
