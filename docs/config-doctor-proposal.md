# Proposal: `rei doctor` — config advisor + hardware-aware model fit

Status: **PROPOSAL / deferred until after the XML-path demolition.** Not implemented.

Motivation: on local models, silent config mistakes degrade everything without failing loudly — we hit
this ourselves with `REI_PRESERVE_THINKING` (repetition loops) and the context window (misdiagnosed as
"QAT breaks tool-calling"). A one-time advisory + an on-demand command would surface these proactively.

## Hard invariant: NEVER pollute the model context

Both the startup warning and the `/doctor` command output go to the TERMINAL only, never into
`session.messages` / the messages sent to the model. The primitive already exists:
`CommandResult.recordInSession` (menu-command-processor.ts) — when false/omitted, the `response` is
displayed but NOT recorded in session history (how `/env`, `/help` already work). So `/doctor` returns
`{ success: true, response, recordInSession: false }`. The startup warning is printed at CLI init,
outside the turn loop. Zero tokens, zero context bloat — ironic to avoid, since the doctor's whole
point is protecting a small local context.

## Part 1 — Config advisor (`config-advisor.ts`, MVP)

A single pure module with one source of truth: `CONFIG_SPEC` — an array where each entry describes a
parameter:

```
{ name, whatItDoes, recommendedForLocal, severity, appliesToLocalOnly, why,
  evaluate?(env) => "ok" | { current, advice } }
```

Three consumers derive from that ONE spec (add a param once → shows up in all three):
1. **Startup warning** — runs `evaluate` for local-only entries, prints only the failing ones, once.
2. **`/doctor`** — same diagnose, on demand.
3. **`/doctor all`** (or `--explain`, `/doctor <PARAM>`) — renders `whatItDoes` / `recommendedForLocal`
   / current value / `why` for every param. Living documentation. This SUPERSEDES the older pending
   `/env` idea (which only dumped `OLLAMA_*` vars) — the explain mode is the "all config, grouped,
   secrets masked, with recommendations" that /env wanted to be.

Local detection: provider not in `CLOUD_CONTEXT_DEFAULTS` (openrouter/gemini/groq/hf) → local
(llmstudio/ollama/unknown). Add a small `isLocalProvider()` helper.

### Initial CONFIG_SPEC checks (prioritized by impact)
| Sev | Param | Rule (local) | Why |
|---|---|---|---|
| 🔴 | context window | `getContextWindow()===0` (neither `REI_CONTEXT_WINDOW` nor `OLLAMA_NUM_CTX` set) | REI sends UNTRIMMED; if the model is loaded small (8192) the server truncates silently → tool-calling breaks. The QAT misdiagnosis. Advise: load ≥30000 or set `REI_CONTEXT_WINDOW` so REI trims. |
| 🟡 | `REI_PRESERVE_THINKING` | `=== "true"` | Re-fed reasoning echoes → repetition loops (now OFF by default). |
| 🟡 | `REI_EDIT_MODE` | `=== "sandbox"` | Per-edit reject loop saturates weak local models; `direct` is optimal on local. |
| 🟡 | `REI_ON_DEMAND_FILE_CONTEXT_*` | ASK/PLANNING `=0` or AGENT `=1` (deviates from smart defaults ASK=1/PLANNING=1/AGENT=0) | ASK/PLANNING=0 dumps whole files → context overflow; AGENT=1 makes it less proactive. |
| 🟢 | reasoning_effort / `REI_MAX_TURNS` / temp+penalty | unset / extreme | Fine tuning ([[rei-reasoning-effort-per-mode]], [[rei-local-model-loop-debugging]]). Later. |

UX: grouped block, colored by severity, non-blocking, suppressible (`REI_SUPPRESS_CONFIG_WARNINGS=1`).
Silent when all-good (no "✓ everything fine" noise). Only "local" triggers it (cloud has large
defaults and doesn't loop the same way). Respect explicit user choices.

## Part 2 — Hardware-aware model fit (bigger; likely its own module/plugin)

Idea: detect the machine's hardware and, from the AVAILABLE models, classify each as
optimal / marginal / won't-fit — so the user picks a model that actually runs well here.

What `hardware-monitor.ts` ALREADY gives (reusable):
- System RAM: `os.totalmem()` / `os.freemem()`.
- Ollama `/api/ps`: per-LOADED-model `size`, `size_vram`, RAM spill, `isFullyInVram`,
  `isPartiallyInRam` — already warns when a model is split VRAM+RAM (slow).

What's MISSING (why it's a separate module):
- Total GPU/VRAM CAPACITY (not just current usage). Platform-specific: Mac unified memory ≈ totalmem;
  discrete NVIDIA needs `nvidia-smi`; AMD/other differ. This detection is the hard, OS-specific part.
- The list of AVAILABLE (installed) models + sizes: Ollama `/api/tags`; LM Studio has its own listing.
- A fit heuristic: `model_size + KV-cache(context_window) vs available VRAM/RAM` → optimal (fully in
  VRAM with headroom) / marginal (spills to RAM → slow) / won't-fit.

Output (CLI-only, same no-context-pollution rule): e.g. `/doctor models` →
```
Detected: 32 GB unified memory (Apple), Ollama reachable, 12 models installed
  ✅ qwen3.6-14b-q4      ~9 GB   fits with headroom
  🟡 qwen3.6-32b-q4     ~20 GB  fits but tight (raise context carefully)
  🔴 llama3-70b-q4      ~40 GB  won't fit — will spill to RAM, very slow
```
Cross `/api/tags` (available + sizes) × detected capacity × the chosen context window.

Scope note: Part 2 is genuinely a bigger, platform-specific effort (VRAM probing per OS, per-provider
model listing, a fit model). Could ship as a separate module or plugin. Part 1 (config advisor) is the
small high-ROI MVP and should land first; Part 2 layers onto the same `/doctor` command later.

## Suggested sequencing
1. XML-path demolition (current milestone).
2. Part 1 config advisor + `/doctor` (+ `/doctor all`), absorbing the `/env` idea.
3. Part 2 hardware-aware model fit (`/doctor models`), as its own module/plugin.
