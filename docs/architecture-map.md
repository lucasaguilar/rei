# REI Architecture Map

A one-page map of the layers and where things live. **Dependency rule: imports point INWARD**
(outer layers use inner layers; inner layers NEVER import outer ones). Companion to
`docs/refactor-plan.md`.

## Layers (outer → inner)

```
┌─ ENTRY / UI ──────────────────────────────────────────────────────────────┐
│  cli/      terminal UI: input handler, keyboard, rendering, run-chat        │
│  server/   HTTP backend entry                                               │
├─ SESSION / ORCHESTRATION ─────────────────────────────────────────────────┤
│  chat/     session store, message-builder, compactor, menu-command-         │
│            processor, plan/spec trackers                                     │
├─ CORE ENGINE ─────────────────────────────────────────────────────────────┤
│  core/         Agent (coordinator) + turn orchestration + helpers           │
│  agent-mode/   the agent loop: generator, generator-tools, loop-guard,      │
│                token-streamer, patch helpers                                 │
├─ CAPABILITIES ────────────────────────────────────────────────────────────┤
│  tools/    command-executor, compile-check (adapters), repo-map, search,    │
│            vision-sidecar, search-replace                                    │
│  skills/   ask-document (chunk/embed/retrieve/verify), skill-loader          │
│  ocr/      pdf-text, pdf-render, ocr-output                                  │
├─ KNOWLEDGE / CONTEXT ─────────────────────────────────────────────────────┤
│  context/    RAG (embedder, vector-store, rag-indexer), AST providers,      │
│              context-builder                                                 │
│  knowledge/  knowledge orchestrator                                          │
│  workspace/  scanner, file-security, project-type                            │
│  language/   per-language capabilities                                       │
├─ PROVIDERS ───────────────────────────────────────────────────────────────┤
│  providers/  LLM providers (ollama, llm-studio, openrouter, gemini, groq,   │
│              hf, mock) + factory + openai-tool-caller + fetch-retry          │
├─ CROSS-CUTTING (leaf — used by everyone, depends on nothing above) ────────┤
│  config/     model-runtime (window/output/reasoning/sampling resolution)    │
│  prompts/    prompt loader + builder (reads prompts/*.md)                    │
│  contracts/  shared interaction/agent types     types/  global types        │
│  telemetry/  optional telemetry wrapper                                      │
└────────────────────────────────────────────────────────────────────────────┘
```

## What each layer may import
- **cli / server** → chat, core, everything below. (UI/entry — nothing imports these.)
- **chat** → core, agent-mode, providers, context, config. Not cli.
- **core / agent-mode** → providers, tools, context, knowledge, config, prompts, contracts. Not chat/cli.
- **tools / skills / ocr / context / knowledge / workspace** → providers, config, contracts. Not core/chat/cli.
- **providers** → config, contracts, fetch util. Not tools/core/chat.
- **config / prompts / contracts / types / telemetry** → (leaf) nothing above. Pure/low-level.

## Key patterns already in place (keep + extend)
- **Provider factory** (`providers/provider-factory.ts`) — strategy by `MODEL_PROVIDER`.
- **Compile adapters** (`tools/compile-check-core.ts`) — pluggable per language.
- **Pluggable embedder** (`context/rag/embedder.ts`) — strategy by `REI_EMBEDDER_PROVIDER`.
- **Skill modules** (`skills/ask-document/*`) — small single-responsibility files.
→ The refactor extends these patterns to **commands** (`chat/menu-command-processor.ts`) and the
  **agent loop phases** (`agent-mode/*`). See the roadmap.

## Refactor backlog (files > 400 lines — enforced by `src/meta/file-size.test.ts`)
`core/agent.ts` · `agent-mode/generator.ts` · `agent-mode/generator-tools.ts` ·
`chat/menu-command-processor.ts` · `tools/command-executor.ts` · `tools/repo-map-generator.ts` ·
`tools/vision-sidecar.ts` · `providers/ollama-provider.ts`. The list only shrinks.
