# Documentation

Thirty-one documents, written at very different moments and for very different reasons. This index
says which is which, because the difference that matters is not the topic — it is whether the
document describes **something that exists**.

A design document for an unbuilt feature is worth keeping: it is the record of a decision, and the
code refers back to it. It is only a problem when a reader mistakes it for a manual. So the sections
below are ordered by that, not by subject.

---

## How REI works today

Start here. These describe shipped behaviour.

| Document | What it covers |
|---|---|
| [rei-internals.md](rei-internals.md) | How the pieces fit: modes, the validation pipeline, prompt assembly, the token budget |
| [config-reference.md](config-reference.md) | Every environment variable, with its default and why it exists |
| [command-execution.md](command-execution.md) | How a shell command is run, gated and reported |
| [agent-loop.md](agent-loop.md) | The native tool-calling loop, turn by turn |
| [prompt-architecture.md](prompt-architecture.md) | How the system prompt is assembled from `prompts/` |
| [patch-workflow-phases.md](patch-workflow-phases.md) | An edit from proposal to verified change |
| [rag-architecture.md](rag-architecture.md) | Semantic indexing — off by default, and why |
| [ocr-architecture.md](ocr-architecture.md) | Images and scanned PDFs through the vision sidecar |
| [security-layer-phase-1.md](security-layer-phase-1.md) | What REI refuses to run, and what it asks about first |
| [architecture-map.md](architecture-map.md) | The directory map, one line per area |
| [local-model-configuration.md](local-model-configuration.md) | Running against LM Studio, Ollama, oMLX |
| [sdd-workflow.md](sdd-workflow.md) | Spec → plan → `/runplan`, the spec-driven loop |
| [ask-document-skill.md](ask-document-skill.md) | `/ask-document` and the active-document target |

**Design notes behind features that shipped** — useful when you want the *why*, not the *how*:
[model-config-spec.md](model-config-spec.md) (per-model tuning in `rei.config.json`) ·
[roles-spec.md](roles-spec.md) (`/role`) ·
[multi-session-spec.md](multi-session-spec.md) (named sessions, `-c`, `--session`) ·
[sub-agent-spec.md](sub-agent-spec.md) (isolated-context sub-agents, the `delegate` tool)

## For contributors

| Document | What it covers |
|---|---|
| [DEVELOPER-GUIDE.md](DEVELOPER-GUIDE.md) | A recipe per extension task: add a slash command, a tool, a provider. Each names the exact files and how to verify |
| [contributor-tour-hop-on-hop-off-style.md](contributor-tour-hop-on-hop-off-style.md) | The whole system end to end, no TypeScript expertise assumed |

See also [AGENTS.md](../AGENTS.md) in the repository root — the working rules, read at runtime as
project conventions.

## Designed, not built

These are decisions on paper. The code links back to several of them, which is why they stay — but
nothing here is implemented, and nothing here is a promise that it will be.

| Document | The idea |
|---|---|
| [intent-router-spec.md](intent-router-spec.md) | Switch mode automatically from the phrasing of a request |
| [config-doctor-spec.md](config-doctor-spec.md) · [config-doctor-proposal.md](config-doctor-proposal.md) | A `/doctor` that audits the configuration and suggests a model that fits the machine |
| [context-drift-spec.md](context-drift-spec.md) | Prune an off-topic detour from the working context instead of carrying it all session |
| [lsp-diagnostics-design.md](lsp-diagnostics-design.md) | A warm per-file check via LSP, replacing the cold `tsc` in the inner loop |
| [model-orchestrator-spec.md](model-orchestrator-spec.md) | Memory-aware loading and unloading across modes |
| [accounting-oracle-spike.md](accounting-oracle-spike.md) | A second vertical: financial documents with an arithmetic oracle in the loop |

## How things got here

Records of migrations and measurements. Nothing to act on; read them when you wonder why something
is shaped the way it is.

[native-path-unification.md](native-path-unification.md) — collapsing every mode onto one native
tool-calling engine, and the 3,140 lines it deleted ·
[stream-tools-spike.md](stream-tools-spike.md) — how streaming arrived on that path ·
[how-context-was-generated.md](how-context-was-generated.md) — what each mode used to send, measured ·
[refactor-plan.md](refactor-plan.md) — the ≤400-line module line and where it started ·
[launch-plan.md](launch-plan.md) — the road from "works on my machine" to a repository someone else
can run
