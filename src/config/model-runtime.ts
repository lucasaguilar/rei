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

// Sensible default context windows for CLOUD providers, applied ONLY when no explicit
// REI_CONTEXT_WINDOW is set. Cloud models have large windows, so reusing a small local
// budget (e.g. 61440) would trim/compact prematurely and degrade them. Override per
// provider with <PREFIX>_CONTEXT_WINDOW (e.g. OPENROUTER_CONTEXT_WINDOW=200000) for a
// model whose window differs from the default. Local providers stay 0 (user sets it to
// the loaded window). Defaults are conservative-large; raise via the per-provider var
// for big-context models, lower it for a small one to avoid overflow.
const CLOUD_CONTEXT_DEFAULTS: Record<
  string,
  { window: number; envPrefix: string }
> = {
  openrouter: { window: 128000, envPrefix: "OPENROUTER" },
  gemini: { window: 128000, envPrefix: "GEMINI" },
  groq: { window: 128000, envPrefix: "GROQ" },
  huggingface: { window: 32000, envPrefix: "HF" },
};

/**
 * Total context window REI assumes for trimming (input + output).
 *
 * Resolution order:
 *  1. `REI_CONTEXT_WINDOW` / `OLLAMA_NUM_CTX` — explicit, always wins (any provider).
 *  2. Cloud provider with no explicit value → `<PREFIX>_CONTEXT_WINDOW` override, else a
 *     large per-provider default — so cloud models aren't trimmed prematurely AND the gauge
 *     still shows a sensible %.
 *  3. Local/unknown provider → `0` (no trimming; LM Studio/Ollama windows are user-set).
 *
 * Uses the agent provider when set (it drives the heavy turns), else the primary provider.
 */
export function getContextWindow(): number {
  const explicit = positiveInt(
    process.env.REI_CONTEXT_WINDOW ?? process.env.OLLAMA_NUM_CTX,
    0,
  );
  if (explicit > 0) return explicit;

  const provider = (
    process.env.AGENT_MODEL_PROVIDER ||
    process.env.MODEL_PROVIDER ||
    ""
  )
    .toLowerCase()
    .trim();
  const cloud = CLOUD_CONTEXT_DEFAULTS[provider];
  if (!cloud) return 0; // local/unknown → no trimming (user-configured)

  return positiveInt(
    process.env[`${cloud.envPrefix}_CONTEXT_WINDOW`],
    cloud.window,
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

// Values the OpenAI-compatible `reasoning_effort` param accepts (LM Studio rejects others,
// e.g. "on"/"off", with a 400). NOTE: a model may internally collapse these to on/off —
// e.g. qwen3.6-35b-a3b maps "none"→off and low/medium/high→on (a harmless server WARN),
// so granular levels only differ on models that actually support them.
const REASONING_EFFORTS = new Set([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);

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
