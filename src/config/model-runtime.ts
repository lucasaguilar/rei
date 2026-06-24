/**
 * Single source of truth for the runtime context/token budget, resolved with
 * clear provider-agnostic `REI_*` names. Legacy provider-specific vars
 * (OLLAMA_NUM_CTX, LLM_STUDIO_MAX_TOKENS, …) are still honored as fallbacks so
 * existing .env files keep working.
 *
 * Resolved here (instead of scattered `process.env` reads) so the context budget,
 * the providers' output cap, and the agent-loop turn limit can never drift apart.
 */

function positiveInt(value: string | undefined, fallback: number): number {
  const n = parseInt(value ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Total context window REI assumes for trimming (input + output). `0` = unknown
 * → no trimming. For Ollama this is also sent as `num_ctx` (so the assumption
 * matches the model's actual loaded context); for LM Studio the real window is
 * set in its UI, so this is REI's budgeting assumption only.
 */
export function getContextWindow(): number {
  return positiveInt(
    process.env.REI_CONTEXT_WINDOW ?? process.env.OLLAMA_NUM_CTX,
    0,
  );
}

/**
 * Max output tokens. ONE value used both as the provider's hard cap AND as the
 * budget's response reserve — so what REI reserves always equals what the model
 * can actually emit (they used to be separate and could be set inconsistently).
 */
export function getMaxOutputTokens(): number {
  return positiveInt(
    process.env.REI_MAX_OUTPUT_TOKENS ??
      process.env.LLM_STUDIO_MAX_TOKENS ??
      process.env.OLLAMA_NUM_PREDICT ??
      process.env.HF_MAX_TOKENS ??
      process.env.REI_RESPONSE_RESERVE,
    8192,
  );
}

/** Maximum iterations of the agent tool-calling loop within a single turn. */
export function getMaxTurns(): number {
  return positiveInt(process.env.REI_MAX_TURNS, 12);
}

const REASONING_EFFORTS = new Set(["none", "low", "medium", "high"]);

/**
 * Resolves the per-mode `reasoning_effort` from `REI_REASONING_EFFORT_<MODE>`
 * (e.g. REI_REASONING_EFFORT_ASK=none, REI_REASONING_EFFORT_AGENT=medium).
 *
 * This is the OpenAI-standard knob LM Studio honors to cap/disable a reasoning model's
 * thinking phase ("none" disables it entirely). Lets you keep agent turns thinking while
 * making ask/planning snappy, without flipping LM Studio's global toggle. Returns
 * undefined when unset/invalid, so the request omits the field and the model uses its own
 * default. Models/backends that don't support the param simply ignore it.
 */
export function resolveReasoningEffort(mode?: string): string | undefined {
  if (!mode) return undefined;
  const raw = process.env[`REI_REASONING_EFFORT_${mode.toUpperCase()}`]
    ?.trim()
    .toLowerCase();
  return raw && REASONING_EFFORTS.has(raw) ? raw : undefined;
}
