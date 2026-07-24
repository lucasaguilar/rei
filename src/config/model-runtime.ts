/**
 * Single source of truth for the runtime context/token budget, resolved with
 * clear provider-agnostic `REI_*` names. Legacy provider-specific vars
 * (OLLAMA_NUM_CTX, LLM_STUDIO_MAX_TOKENS, …) are still honored as fallbacks so
 * existing .env files keep working.
 *
 * Resolved here (instead of scattered `process.env` reads) so the context budget,
 * the providers' output cap, and the agent-loop turn limit can never drift apart.
 *
 * Per-model overrides (rei.config.json, via getActiveModelTuning) take precedence over the env
 * defaults here — see docs/model-config-spec.md.
 */
import { getActiveModelTuning } from "./model-tuning.js";

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

/** Per-provider runtime config. Local providers (ollama, llmstudio, mtplx) use contextWindow=0
 *  (no trimming; user sets the loaded window). Cloud providers get a large default so they
 *  aren't trimmed prematurely. */
const PROVIDER_RUNTIME_CONFIGS: Record<
  string,
  {
    contextWindow: number;
    maxOutputTokens?: number;
    tokenLimit?: number;
    supportsToolCalling: boolean;
    supportsReasoning: boolean;
    isLocal: boolean;
  }
> = {
  ollama: { contextWindow: 0, supportsToolCalling: true, supportsReasoning: false, isLocal: true },
  llmstudio: { contextWindow: 0, supportsToolCalling: true, supportsReasoning: false, isLocal: true },
  mtplx: { contextWindow: 0, supportsToolCalling: true, supportsReasoning: false, isLocal: true },
  openrouter: { contextWindow: 128000, supportsToolCalling: true, supportsReasoning: true, isLocal: false },
  gemini: { contextWindow: 128000, supportsToolCalling: true, supportsReasoning: false, isLocal: false },
  groq: { contextWindow: 128000, supportsToolCalling: true, supportsReasoning: false, isLocal: false },
  huggingface: { contextWindow: 32000, supportsToolCalling: true, supportsReasoning: false, isLocal: false },
  mock: { contextWindow: 4096, supportsToolCalling: false, supportsReasoning: false, isLocal: true },
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
  // Per-model override (rei.config.json) wins — and fixes the "stale global window on model switch"
  // footgun: each model can declare its own window.
  const tuned = getActiveModelTuning()?.contextWindow;
  if (tuned && tuned > 0) return tuned;

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

  // Check runtime config first (local providers like mtplx/llmstudio have contextWindow=0)
  const runtime = PROVIDER_RUNTIME_CONFIGS[provider];
  if (runtime && runtime.contextWindow === 0) return 0;

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
  const tuned = getActiveModelTuning()?.maxTokens;
  if (tuned && tuned > 0) return tuned;
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

/** Whether the orchestrator may delegate to isolated-context sub-agents (the `delegate` tool).
 *  Opt-in (default OFF): delegation is experimental + model-dependent — enable it to evaluate.
 *  See docs/sub-agent-spec.md. */
export function subAgentsEnabled(): boolean {
  return process.env.REI_SUBAGENT_ENABLED === "true";
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
  // Defensive: tolerate a trailing inline comment (" #...") that a naive .env loader may
  // have left in the value (e.g. the bash wrapper used to export `none   # note` verbatim,
  // which failed the set check → reasoning silently stayed ON). reasoning_effort values
  // never contain '#', so splitting on it is safe.
  const raw = process.env[`REI_REASONING_EFFORT_${mode.toUpperCase()}`]
    ?.split("#")[0]
    .trim()
    .toLowerCase();
  if (raw && REASONING_EFFORTS.has(raw)) return raw;
  // No explicit env → honor the active model's `thinking` intent. "off" → reasoning_effort:none
  // (the lever LM Studio honors). "on"/unset → the model's own default (undefined). The mlx_lm
  // /no_think lever is a later phase; see docs/model-config-spec.md.
  const thinking = getActiveModelTuning()?.thinking;
  if (thinking === "off") return "none";
  return undefined;
}

/**
 * Whether to RE-SEND the model's prior `reasoning_content` back to it on later calls (and keep
 * `<think>` blocks in stored history). Single source of truth for the whole pipeline.
 *
 * DEFAULT OFF (opt-in with REI_PRESERVE_THINKING=true). Re-feeding reasoning piles up near-identical
 * prior thoughts inside the native tools loop and makes local models echo them → repetition loops
 * (the same find/grep or git command re-issued many times). Industry-standard usage treats thinking
 * as ephemeral-per-turn, not re-fed; the continuity benefit is speculative while the loop cost is
 * concrete. Opt in only for a model that demonstrably benefits from seeing its prior reasoning.
 */
export function preserveThinkingEnabled(): boolean {
  return process.env.REI_PRESERVE_THINKING === "true";
}

function floatInRange(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const n = parseFloat(value ?? "");
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export interface AgentSampling {
  temperature: number;
  frequencyPenalty: number;
  presencePenalty: number;
  /** From per-model tuning only (config-only, no env knob). Sent to the model when defined. top_k
   *  is a non-OpenAI-standard extension local runtimes accept; omitted unless configured. */
  topP?: number;
  topK?: number;
}

/**
 * Sampling parameters for the agent/tools path (the shared OpenAI-compatible
 * `completeChatWithTools`). Provider-agnostic — it serves Ollama, OpenRouter, LM Studio
 * and Groq, so it is NOT coupled to any provider's own env names.
 *
 * The tools path historically hardcoded `temperature: 0` (greedy). Greedy decoding is the
 * #1 cause of repetition loops on local models — REI's own non-tools chat path already
 * avoids it (mild temperature + repetition penalties). The agent is exactly where loops
 * bite, yet it was decoding greedily. Defaults here add a mild temperature + frequency /
 * presence penalties to break those loops at the source (complementing the degenerate-guard,
 * which only catches a loop AFTER it starts).
 *
 * Override per knob:
 *   REI_AGENT_TEMPERATURE         (default 0.3; set 0 for deterministic tool-calls, e.g. cloud)
 *   REI_AGENT_FREQUENCY_PENALTY   (default 0.3)
 *   REI_AGENT_PRESENCE_PENALTY    (default 0.3)
 */
export function resolveAgentSampling(): AgentSampling {
  // Per-model tuning (rei.config.json) wins over the global env knob for each parameter.
  const t = getActiveModelTuning();
  const pick = (value: number | undefined, env: string | undefined): number =>
    value !== undefined ? clampFloat(value, 0, 2) : floatInRange(env, 0.3, 0, 2);
  return {
    temperature: pick(t?.temperature, process.env.REI_AGENT_TEMPERATURE),
    frequencyPenalty: pick(t?.frequencyPenalty, process.env.REI_AGENT_FREQUENCY_PENALTY),
    presencePenalty: pick(t?.presencePenalty, process.env.REI_AGENT_PRESENCE_PENALTY),
    topP: t?.topP,
    topK: t?.topK,
  };
}

/** Clamps a numeric config value into [min,max] (out-of-range → nearest bound). */
function clampFloat(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}
