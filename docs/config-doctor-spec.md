# Spec: `/doctor` — onboarding accelerator + config advisor + model fit

Status: **SPEC (defined, not implemented).** Supersedes `docs/config-doctor-proposal.md`
(that stays as the original motivation note; this is the buildable spec).

## 1. Vision & goal

> A stranger who has never seen REI should go from `npx rei` to **editing a file in their
> own repo in under 60 seconds** — on local models, cloud models, or hybrid — without
> reading a single doc.

Two problems `/doctor` attacks:

1. **Cold start friction.** Today the right config is tribal knowledge (context window,
   agent sampling, edit mode, recommended model). A newcomer either copies `.env.example`
   by hand or guesses. → **`/doctor init <lane>`** writes a known-good config in one step.
2. **Silent degradation.** Local models don't fail loudly on bad config — they loop, stall,
   or drop tool-calls (we misdiagnosed a small context window as "QAT breaks tool-calling",
   and `REI_PRESERVE_THINKING` as model flakiness). → **`/doctor`** surfaces these with
   severity + why, terminal-only, zero tokens.

## 2. Hard invariants

- **Never pollute model context.** All `/doctor` output is terminal-only via
  `CommandResult.recordInSession: false` (how `/env`/`/help` work). Startup advisory prints
  at CLI init, outside the turn loop. Zero tokens.
- **Never clobber user config.** `/doctor init` writes only *unset/empty* keys by default,
  shows a diff, and asks before overwriting any non-empty value. API keys are prompted, never
  invented. The workspace `.env` is the target (per-project; wins over `~/.rei/.env`).
- **Silent when healthy.** No "✓ all good" noise. Only failing checks print.
- **Respect explicit choices.** A user who set `REI_EDIT_MODE=sandbox` on purpose gets a 🟡
  note, not a nag; suppressible via `REI_SUPPRESS_CONFIG_WARNINGS=1`.

## 3. Architecture — three sources of truth

One data module, three tables, feeding every surface (wizard, startup, `/doctor`, `.env.example`).

| Source of truth | Shape | Feeds |
|---|---|---|
| `QUICKSTART_PROFILES` | per-lane `.env` preset (local / cloud / hybrid) | `/doctor init`, launch wizard, generated `.env.example` header |
| `CONFIG_SPEC` | per-param `{name, whatItDoes, recommendedForLocal, severity, appliesToLocalOnly, why, evaluate(env)}` | startup advisory, `/doctor`, `/doctor all` |
| `RECOMMENDED_MODELS` | per-provider/hardware tier model list | `/doctor init` defaults, `/doctor models` |

Add a knob once → it shows up in init, in diagnosis, and in the explain view. No drift.

`isLocalProvider(p)` = provider ∉ `{openrouter, gemini, groq, hf}` (i.e. lmstudio/ollama/mtplx/unknown).

## 4. Command surface

```
/doctor                 diagnose the current workspace config (severity-ranked, silent if clean)
/doctor all             explain EVERY parameter: what it does, recommended, current, why
                        (supersedes the old /env idea — grouped, secrets masked)
/doctor <PARAM>         explain one parameter
/doctor init local      write a known-good LOCAL preset to workspace .env (non-destructive)
/doctor init cloud      write a CLOUD preset (prompts for API key)
/doctor init hybrid     write a HYBRID preset (local ask/planning + cloud agent)
/doctor models          [Phase 3] hardware-aware fit of installed models
```

Plus the **startup advisory**: on CLI init, run the local-only checks and print only the
failing ones, once. Suppressible.

## 4b. First-run wizard (shares QUICKSTART_PROFILES)

The `rei` no-`.env` first-run wizard is a consumer of the same profiles. Redesign decisions:

- **Lane-first question**, plain language, replacing the "single/multi provider" jargon:
  `☁️ Cloud (easiest, one API key)` / `💻 Local (private+free, needs LM Studio/Ollama)` /
  `🔀 Hybrid`. **Default highlighted = Cloud** (lowest friction for a newcomer; local is the
  "now make it private" step 2).
- **Cloud lane MUST prompt for the API key** and persist it to `.env`. This is a current bug:
  the wizard writes `OPENROUTER_MODEL` but never `OPENROUTER_API_KEY`, so the cloud path
  crashes at runtime. Covered-path rule: every lane ends in a working first edit.
- Model pre-filled from `RECOMMENDED_MODELS` (editable), not a raw list.
- Local lane: reachability-check the server, then a **safe non-zero context-window preset with a
  one-line why** (today's default `0` = no trimming is the silent-truncation footgun).
- Workspace defaults to cwd (confirm, not select-from-list). Server mode / per-mode agent model /
  penalties move to "advanced" (hidden by default).
- Target: `rei` → first edit in ~3 prompts (lane → key-or-model → enter), zero raw numbers.

## 5. QUICKSTART_PROFILES (the presets)

These are the buildable form of what's already commented at the top of `.env.example`.
`/doctor init <lane>` merges the chosen block into workspace `.env`.

### Lane A — LOCAL (LM Studio / Ollama, offline, free)
```
MODEL_PROVIDER=lmstudio
LLM_STUDIO_MODEL=<recommended agent model>      # ask + planning + agent
LLM_STUDIO_MODEL_AGENT=<recommended agent model>
REI_CONTEXT_WINDOW=61440                         # MUST match window loaded in LM Studio (🔴 the #1 gotcha)
REI_AGENT_TEMPERATURE=0.6                         # tool-calling path; below ~0.6 qwen-class drifts
REI_REASONING_EFFORT_ASK=none                    # snappy ask
REI_EDIT_MODE=direct                             # sandbox saturates local loops
REI_PRESERVE_THINKING=false                       # re-fed reasoning loops local models
REI_ON_DEMAND_FILE_CONTEXT_ASK=1
REI_ON_DEMAND_FILE_CONTEXT_PLANNING=1
REI_ON_DEMAND_FILE_CONTEXT_AGENT=1               # local: on-demand in ALL modes keeps the small window from overflowing (AGENT=0 = proactive full context, only safe on big windows)
# REI_ENABLE_RAG unset                           # RAG semantic index is OFF by default — on-demand modes don't use it; set =1 only for proactive agent (AGENT=0) wanting semantic file selection
# REI_VISION_MODEL=qwen/qwen3-vl-4b              # optional: image / PDF OCR
```

### Lane B — CLOUD (OpenRouter, large context, premium)
```
MODEL_PROVIDER=openrouter
OPENROUTER_API_KEY=<prompted>
OPENROUTER_MODEL=<recommended cloud model>       # ask + planning + agent
OPENROUTER_MODEL_AGENT=<recommended cloud model>
# REI_CONTEXT_WINDOW left UNSET → auto 128000 (cloud default); never trims prematurely.
# Agent sampling: cloud models are robust; leave REI_AGENT_TEMPERATURE default.
```

### Lane C — HYBRID (local ask/planning, cloud agent)
```
MODEL_PROVIDER=lmstudio
AGENT_MODEL_PROVIDER=openrouter                   # heavy agent turns → cloud
LLM_STUDIO_MODEL=<recommended local model>        # fast local ask/planning
OPENROUTER_MODEL_AGENT=<recommended cloud model>  # reliable agent tool-calling
OPENROUTER_API_KEY=<prompted>
REI_CONTEXT_WINDOW=61440                           # applies to the local ask/planning provider
# window for the agent auto-resolves from openrouter (128000).
```

Why these three lanes: they map to the three real user postures — *offline/private/free*,
*best-quality/zero-setup-friction*, *cheap-local-for-cheap-work + cloud-for-hard-work*.

## 6. RECOMMENDED_MODELS

Selection gate is **tool-calling reliability**, not size or speed — a model that silently
drops tool-calls is useless as an agent regardless of benchmark scores.

### Local (LM Studio / Ollama) — tiered by unified memory / VRAM
| Tier | RAM/VRAM | Suggested | Notes |
|---|---|---|---|
| Sweet spot | 32 GB+ | `mlx-community/ornith-1.0-35b` (validated reliable tool-caller in REI) | 35B-A3B MoE; load window ≥30k |
| Sweet spot alt | 32 GB+ | `qwen/qwen3.6-35b-a3b` | works but sometimes drops tool-calls at low temp; keep `REI_AGENT_TEMPERATURE≈0.6` |
| Mid | 16–24 GB | 14B-class instruct w/ tool support | verify tool-calling before trusting agent mode |
| Vision | any | `qwen/qwen3-vl-4b` | OCR / image input sidecar |

> Honesty note: only the 35B-class above is validated end-to-end in REI. Smaller tiers are
> starting points — `/doctor models` (Phase 3) will confirm fit + the user confirms tool-calling.

### Cloud
| Provider | Suggested start | Why |
|---|---|---|
| OpenRouter | a current strong tool-calling model (e.g. `qwen/qwen3.6-plus`) | one key, many models, 128k default |
| Groq | fast tool-capable model | speed |
| Gemini | needs `omitParams` strip (already handled) | — |

`RECOMMENDED_MODELS` stores the concrete IDs so `/doctor init` fills them and there's ONE
place to bump them as models evolve.

## 7. CONFIG_SPEC — parameter reference

Full env audit lives in `docs/config-reference.md` (companion). The checks the advisor runs:

### Sampling has TWO sources (the #1 confusion — encode it as a check)
- **Agent/tools path** uses `REI_AGENT_TEMPERATURE / _FREQUENCY_PENALTY / _PRESENCE_PENALTY`
  (agnostic, default **0.3**) — `openai-tool-caller.ts:119-131`.
- **Chat/ask path** uses `<PROVIDER>_TEMPERATURE` etc. — `openai-compatible-provider.ts:256`.
- 🟡 check: if `<PROVIDER>_TEMPERATURE` is set but `REI_AGENT_TEMPERATURE` is unset, warn that
  the agent still runs at 0.3 (the provider temp does NOT reach the agent path).

### Initial checks (prioritized by impact)
| Sev | Param | Rule (local) | Why |
|---|---|---|---|
| 🔴 | context window | `getContextWindow()===0` (no `REI_CONTEXT_WINDOW`/`OLLAMA_NUM_CTX`) | REI sends UNTRIMMED; small-loaded model truncates silently → tool-calling breaks. The "QAT" misdiagnosis. |
| 🟡 | `REI_AGENT_TEMPERATURE` | unset while `<PROVIDER>_TEMPERATURE` set | agent runs at default 0.3; qwen-class drifts below ~0.6 |
| 🟡 | `REI_PRESERVE_THINKING` | `=== "true"` | re-fed reasoning echoes → repetition loops |
| 🟡 | `REI_EDIT_MODE` | `=== "sandbox"` | per-edit reject loop saturates weak local models; `direct` optimal |
| 🟡 | `REI_ON_DEMAND_FILE_CONTEXT_ASK/_PLANNING` | `=0` on local | dumps whole files → small window overflow. (NOTE: `AGENT=1` is NOT flagged — on local it's the recommended way to keep the window small; `AGENT=0` = proactive full context, only for big windows.) |
| 🟢 | `REI_ENABLE_RAG` / `REI_SKIP_RAG` | RAG is OFF by default | no action needed on local — on-demand modes don't use the semantic index, so a lighter repo entry is the default. `REI_SKIP_RAG=true` is now redundant (harmless). Only advise `REI_ENABLE_RAG=1` when `REI_ON_DEMAND_FILE_CONTEXT_AGENT=0` (proactive agent) AND the user wants semantic file selection. Do NOT flag its absence. |
| 🟢 | reasoning_effort / `REI_MAX_TURNS` | extreme | fine tuning; later |

## 8. Implementation phases

1. **Phase 1 — advisor + explain (MVP, high ROI).** `config-advisor.ts` with `CONFIG_SPEC`;
   wire startup advisory + `/doctor` + `/doctor all`. Absorbs the `/env` idea. Pure module,
   fully unit-testable (`evaluate(env)` is a pure fn). Terminal-only.
2. **Phase 2 — quickstart init.** `QUICKSTART_PROFILES` + `RECOMMENDED_MODELS`; `/doctor init
   <lane>` writes workspace `.env` non-destructively (diff + confirm + key prompt). Refactor the
   launch wizard to consume the same profiles (kills the duplicated preset text in the wizard and
   `.env.example`). This is the "60-seconds-to-first-edit" payoff.
3. **Phase 3 — model fit.** `/doctor models`: extend `hardware-monitor.ts` with VRAM capacity +
   installed-model listing (`/api/tags`, LM Studio listing) + fit heuristic
   (`model_size + KV(context) vs capacity`). Bigger, OS-specific; own module.

Sequencing rationale: Phase 1 protects existing users immediately; Phase 2 delivers the
onboarding promise; Phase 3 is the deep hardware work that can layer on later.
