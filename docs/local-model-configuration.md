# Local Model Configuration for REI

> **Goal:** Tune sampling parameters per-model so local LLMs (Ornith, Qwen, etc.) execute tools reliably without repetition loops, excessive thinking, or flaky patches.

---

## Why This Matters

REI's agent loop is where sampling parameters matter most. The model calls tools (`edit_file`, `read_files`, shell commands), applies patches to the filesystem, and runs auto-verify (`tsc --noEmit`). If the sampling is wrong:

| Symptom | Root Cause |
|---|---|
| Same tool call repeats 4+ times in one turn | `temperature: 0` (greedy) → degenerate loop |
| Patches fail verify, model retries 3+ times | `temperature` too high → syntactic noise |
| Model "thinks" for 2000+ tokens before acting | `reasoning_effort` too high, or `preserveThinking` on |
| Tool calls malformed / hallucinated | `frequencyPenalty` too low → token repetition |

---

## Current Architecture

REI resolves sampling parameters in **`src/config/model-runtime.ts`**:

```
resolveAgentSampling() → { temperature, frequencyPenalty, presencePenalty }
```

Resolution order (global, same for all models):

| Parameter | Env Variable | Default | Range |
|---|---|---|---|
| `temperature` | `REI_AGENT_TEMPERATURE` | `0.3` | 0–2 |
| `frequencyPenalty` | `REI_AGENT_FREQUENCY_PENALTY` | `0.3` | 0–2 |
| `presencePenalty` | `REI_AGENT_PRESENCE_PENALTY` | `0.3` | 0–2 |

**Limitation:** One set of values for all models. What's optimal for Ornith 35B is not optimal for Qwen 35B-A3B.

Each provider (`lm-studio-provider.ts`, `mtplx-provider.ts`) also has its own defaults at the provider level (`0.6` temp, `0.3` penalties), which apply to non-agent chat paths.

---

## Recommended Parameters Per Model

### Ornith 1.0-35B (MoE, ~3B active)

```
temperature:        0.35   # Code-first MoE; low exploration prevents syntax noise
frequencyPenalty:   0.8    # Strong repetition guard — MoE can loop on token patterns
presencePenalty:    0.6    # Moderate — keeps output diverse without losing coherence
reasoning_effort:   "none" # Ornith was trained with self-scaffolding, not native thinking
```

**Why:** Ornith is a MoE trained with self-scaffolding RL (plan → act → retry). It doesn't need a thinking phase; its training loop already bakes in the planning step. Low temperature keeps tool calls deterministic.

---

### Qwen 3.6-27B (Dense, MLX)

```
temperature:        0.4    # Dense model needs slightly more exploration than MoE
frequencyPenalty:   0.8    # Prevents repeating imports, patterns, common tokens
presencePenalty:    0.6    # Keeps output flowing without re-using recent context
reasoning_effort:   "low"  # If using the -thinking variant; otherwise "none"
```

**Why:** 77.2% SWE-bench score; strong coder but benefits from mild exploration. The `-thinking` variant should use `reasoning_effort: "low"` to avoid excessive internal reasoning that wastes context window.

---

### Qwen 3.6-35B-A3B (MoE, Qwen official)

```
temperature:        0.6    # Qwen team's official recommendation for precise coding
frequencyPenalty:   0.5    # Official docs don't specify; moderate is safe
presencePenalty:    0.0    # Qwen official: presence_penalty=0 for coding/thinking
reasoning_effort:   "low"  # If using -thinking variant; Qwen maps "none"→off, low→on
```

**Why:** Qwen's official documentation recommends `temperature=0.6` and `presence_penalty=0` for coding tasks. The MoE architecture (3B active of 35B) is more robust to higher temperature than a dense model.

---

### Gemma (any variant)

```
temperature:        0.35   # Gemma benefits from deterministic decoding for tool calls
frequencyPenalty:   0.7    # Moderate repetition guard
presencePenalty:    0.5    # Light — Gemma is sensitive to high presence penalty
reasoning_effort:   "none" # Gemma doesn't support native thinking
```

**Why:** Gemma models are sensitive to `presencePenalty > 0.7` (output degrades). Keep it moderate and let `frequencyPenalty` do the loop-breaking work.

---

## Applying Per-Model Overrides

### Option 1: JSON in `.env` (portable, no code changes)

Add a single variable that maps normalized model names to their sampling config:

```env
REI_MODEL_SAMPLING_OVERRIDES={
  "ornith-1.0-35b": { "temperature": 0.35, "frequencyPenalty": 0.8, "presencePenalty": 0.6 },
  "qwen3.6-27b": { "temperature": 0.4, "frequencyPenalty": 0.8, "presencePenalty": 0.6 },
  "qwen3.6-35b-a3b": { "temperature": 0.6, "frequencyPenalty": 0.5, "presencePenalty": 0.0 },
  "gemma": { "temperature": 0.35, "frequencyPenalty": 0.7, "presencePenalty": 0.5 }
}
```

**How it works:**
1. REI reads `LMSTUDIO_MODEL` (e.g., `mlx-community/ornith-1.0-35b`)
2. Normalizes: strips prefix → `ornith-1.0-35b`
3. Looks up in the JSON map
4. Merges overrides on top of global defaults (`resolveAgentSampling()`)

**Fallback chain:** `env override → global defaults` (unknown models always work)

### Option 2: Built-in model table + env override

A TypeScript object in `model-runtime.ts` with known models pre-configured, overridable via `.env`:

```ts
const MODEL_SAMPLING_MAP = {
  "ornith-1.0-35b":       { temperature: 0.35, frequencyPenalty: 0.8, presencePenalty: 0.6 },
  "qwen3.6-27b":          { temperature: 0.4,  frequencyPenalty: 0.8, presencePenalty: 0.6 },
  "qwen3.6-35b-a3b":      { temperature: 0.6,  frequencyPenalty: 0.5, presencePenalty: 0.0 },
};
```

**Priority:** `env override > built-in table > global defaults`

---

## Model Name Detection

### The Problem

Model names arrive from different sources with different formats:

| Source | Example |
|---|---|
| HuggingFace full ID | `mlx-community/ornith-1.0-35b` |
| LM Studio UI | `mlx-community/qwen3.6-27b` |
| User shorthand | `ornith` |
| Thinking variant | `mlx-community/qwen3.6-27b-thinking` |

### Normalization Strategy

```
"mlx-community/Ornith-1.0-35B"  →  lowercase  →  strip prefix  →  "ornith-1.0-35b"
"qwen3.6-27b-thinking"          →  lowercase  →  strip suffix  →  "qwen3.6-27b"
```

**Matching:** `normalized.includes(key) || key.includes(normalized)` — handles both full and short names.

---

## Preventing Thinking Loops

### `REI_REASONING_EFFORT_<MODE>`

Per-mode reasoning control. For local models:

```env
REI_REASONING_EFFORT_AGENT=low    # Agent turns: mild thinking, more action
REI_REASONING_EFFORT_ASK=none     # Ask mode: no thinking, direct answer
REI_REASONING_EFFORT_PLANNING=medium  # Planning: deeper reasoning
```

### `REI_PRESERVE_THINKING`

**Default: `false`.** Re-feeding prior thinking blocks into subsequent turns causes local models to echo their own reasoning → repetition loops.

```env
REI_PRESERVE_THINKING=false   # Default — do NOT re-send prior thinking
```

Only enable for models that demonstrably benefit (rare with local models).

---

## Quick Reference: Your `.env` for 3 Local Models

```env
# ── Provider & model ──
LMSTUDIO_MODEL=mlx-community/ornith-1.0-35b

# ── Global defaults (fallback for unknown models) ──
REI_AGENT_TEMPERATURE=0.3
REI_AGENT_FREQUENCY_PENALTY=0.3
REI_AGENT_PRESENCE_PENALTY=0.3

# ── Per-model overrides (JSON) ──
REI_MODEL_SAMPLING_OVERRIDES={
  "ornith-1.0-35b": { "temperature": 0.35, "frequencyPenalty": 0.8, "presencePenalty": 0.6 },
  "qwen3.6-27b": { "temperature": 0.4, "frequencyPenalty": 0.8, "presencePenalty": 0.6 },
  "qwen3.6-35b-a3b": { "temperature": 0.6, "frequencyPenalty": 0.5, "presencePenalty": 0.0 }
}

# ── Reasoning per mode ──
REI_REASONING_EFFORT_AGENT=low
REI_REASONING_EFFORT_ASK=none
REI_REASONING_EFFORT_PLANNING=medium

# ── Thinking persistence ──
REI_PRESERVE_THINKING=false
```

---

## Implementation Notes

- **No new files required** — everything fits in `model-runtime.ts` + `.env`
- **No breaking changes** — unknown models fall through to existing behavior
- **Runtime resolution** — no recompile needed when changing `.env`
- **Works with hot model switching** — `resolveModelSampling(this.model)` called per-provider instantiation
