<div align="center">
<pre>
██████╗ ███████╗██╗
██╔══██╗██╔════╝██║
██████╔╝█████╗  ██║
██╔══██╗██╔══╝  ██║
██║  ██║███████╗██║
╚═╝  ╚═╝╚══════╝╚═╝
</pre>
  <h1>REI — Just REI</h1>
  <p><em>A sniper-precision, local-first AI coding agent</em></p>
</div>

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

**REI** is a next-generation, compiler-aware AI coding agent built for developers who demand absolute privacy, complete code traceability, and zero-compromise intelligence. Engineered with a unique **hybrid local-first, multi-brain, and multi-provider architecture**, REI adapts dynamically to your needs—running either 100% offline or orchestrating local speed with premium cloud models. Operating as an interactive terminal CLI and a high-performance backend server, it integrates seamlessly into your local workspace and IDE workflows (such as Continue.dev).

---

## 🌟 The Core Pillars of REI

Unlike generic, conversational coding assistants, REI acts as a **surgical developer companion** by combining offline structural understanding with advanced hybrid LLM routing.

### 1. 🧠 Hybrid "Multi-Brain" Architecture (Multi-Cerebro)
REI allows you to configure two powerful operational setups depending on your security, hardware, and intelligence requirements:

* **100% Local Multi-Brain Setup (Fully Private & Offline):**
  Run completely local on your own hardware using Ollama or LM Studio with zero data leakage. Route lightweight conversational turns (Ask/Planning) to fast models like `llama3.2` or `qwen2.5-coder:7b`, while delegating heavy agentic file edits to larger coding models running locally (such as `qwen2.5-coder:14b` or the outstanding **`qwen/qwen3.6-35b-a3b`**).
* **Pro Hybrid Multi-Brain & Multi-Provider Setup (Local Speed + Cloud Power):**
  Combine the speed of local hardware with the surgical capability of state-of-the-art cloud intelligence. Run your everyday chat and architectural planning locally and for free (using local Ollama models), and dynamically route complex XML-based agent edits to premium cloud APIs (such as **`qwen/qwen3.6-plus`** or `anthropic/claude-3.5-sonnet` via OpenRouter).
* **Hot-Swapping:** Use dynamic chat commands (e.g. `/provider agent openrouter` and `/model agent qwen/qwen3.6-plus`) to adjust routing in real-time without restarting the session.

### 2. 🌲 Surgical AST Intelligence (`ts-morph` & `web-tree-sitter`)
REI doesn't "guess" or rely on flaky regex searches. It parses your codebase's abstract syntax tree natively:
* **TypeScript & JavaScript (God Mode):** Uses `ts-morph` to map classes, functions, and interfaces, automatically performing **Caller Discovery** to find and load all files affected by a symbol change.
* **Polyglot Codebases (Standard Mode):** Incorporates `web-tree-sitter` for advanced structural understanding of Python, Rust, Go, Java, and other languages.

### 3. 🧪 Sandbox Auto-Healing & Compiler-Awareness
REI refuses to break your repository. When executing code changes in Agent Mode:
1. **Isolated Sandbox:** REI creates a temporary directory copy of the workspace to apply edits.
2. **Type & Compilation Checking:** Runs type verification (e.g., `npx tsc --noEmit` for TypeScript).
3. **Optional TDD Loop:** Automatically runs the project's test suite (`npm run test`) to validate functionality.
4. **Auto-Healing:** If the compiler or test suite reports an error, REI feeds the diagnostics back to the LLM for automatic correction, presenting the patch to you only once it compiles flawlessly.

### 4. ⚡ Offline Semantic RAG Engine
REI features an ultra-fast, entirely local Retrieval-Augmented Generation pipeline:
* **Local Embeddings:** Uses the `Xenova/all-MiniLM-L6-v2` ONNX model via `@xenova/transformers` directly in Node.js. Your code is embedded locally on CPU—never sent to cloud APIs.
* **AST-Aware Chunking:** Chunks files by classes, functions, and interfaces rather than character counts.
* **Incremental FS-Watching:** Uses `chokidar` to track file modifications and incrementally update the `.rei/rag-index.json` database in milliseconds.

### 5. 📊 Bulletproof Data Traceability
Every single step REI takes is logged transparently. REI outputs structured telemetry directly to `.rei/logs/agent-flow.jsonl`, detailing:
* Semantic search scores and file ranking.
* Which symbols and caller references were discovered.
* The exact diffs proposed, compilation errors encountered, and sandbox auto-healing cycles.

## 📥 Installation & Scripts Setup

You can install REI globally using our streamlined shell scripts or compile it manually from source.

### 1. Automated Global Installation (via curl)
To install the interactive CLI globally and configure a dedicated symlink launcher inside `~/.local/bin/rei`:

```bash
# Install the CLI globally
curl -fsSL https://raw.githubusercontent.com/lucasaguilar/rei/main/install-rei-cli.sh | bash
```

To install the backend server API for VS Code Continue.dev plugin integration, creating a launcher at `~/.rei/rei-server`:

```bash
# Install the backend server API
curl -fsSL https://raw.githubusercontent.com/lucasaguilar/rei/main/install-rei-server.sh | bash
```

> [!NOTE]
> These installers clone the project into `~/.rei`, install Node dependencies, compile the TypeScript code, and generate a global configuration file at `~/.rei/.env`.

### 2. Local Source Installation (For Developers)
To install using your current local working copy:

```bash
# From the root of your cloned repository
./install-rei-cli-local.sh
```

Or manually step-by-step:
```bash
git clone https://github.com/lucasaguilar/rei.git
cd rei
npm install
npm run build
npm install -g .
```

---

## 🚀 Running REI & Execution Cases

REI can be run in three different modes depending on your workflow:

### 1. CLI Interactive Curses UI
Start the full-screen terminal workspace. Highly recommended for tmux and vim power-users:

```bash
# Launch interactive session inside current directory
rei

# Force launch the Interactive Configuration Wizard
rei --config
```

> [!TIP]
> **First-Run Autoconfig:** If you run `rei` and no configuration (`.env` file) is found, REI will automatically start the **Interactive Configuration Wizard** (`launch-rei.js`). The wizard guides you step-by-step to select your workspace, choose your LLM providers and models, adjust context window sizes, and automatically generates and persists your workspace `.env` file so subsequent runs are instant and error-free!
```

### 2. One-Shot Planning Tasks
For quick, single-command architectural designs and planning tasks:
```bash
rei plan "Design a robust caching decorator for the API service"

# Run planning on another repository
rei --workspace /path/to/another/project plan "Add email notification support"
```

### 3. API Server for IDE Extensions (Continue.dev)
Start the high-performance local server to act as a backend endpoint:
```bash
# Run the compiled server on port 3000
~/.rei/rei-server

# Or run in development mode from source
npm run server:dev
```

---

## 🎮 Practical Use Case: Step-by-Step `/runplan` Cycle

REI excels at executing multi-stage architectural changes. Here is a real-world walkthrough of a complete feature implementation:

### 1. Planning the Feature
Switch to Planning Mode inside the chat to brainstorm and design the implementation:
```text
/mode planning
Plan the implementation of a new state store for market listing indices.
```
REI analyzes the codebase structure using local RAG and AST analysis, then outputs a structured, markdown-compatible design plan divided into distinct milestones (e.g., `### Stage 1: Define Interface`, `### Stage 2: Create Store Service`, etc.).

### 2. Auto-Checklist Generation
As soon as the plan is presented, REI automatically creates an active progress tracking checklist inside your workspace directory at **`.rei/current-plan-todo.md`**:
```markdown
# PLAN PROGRESS
- [ ] **Etapa 1:** Define Interface
- [ ] **Etapa 2:** Create Store Service
```

### 3. Automated Stage Execution
To execute the first stage of the plan, run `/runplan` followed by the target stage:
```text
/runplan stage 1
```
REI will:
1. Transition dynamically to **Agent Mode**.
2. Run **AST Caller Discovery** to identify all files and references affected by the new interfaces.
3. Call your premium agent model (e.g., `qwen/qwen3.6-plus` on OpenRouter) to write/modify the exact code.

### 4. Sandbox auto-healing & Compilation
Before the code is written back to your workspace:
* REI copies the files to an isolated **temporary sandbox**.
* It applies the proposed changes and runs type diagnostics (`npx tsc --noEmit`).
* If typescript compiler errors are found (e.g., a missing export, wrong type cast), REI feeds the exact compiler diagnostic block back to the LLM for **Auto-Healing**.
* Once the edits compile with **zero type errors**, the verified code is cleanly applied to your working directory.

### 5. Automated Checklist Update
Upon successful execution, REI automatically updates your progress file (`.rei/current-plan-todo.md`):
```markdown
# PLAN PROGRESS
- [x] **Etapa 1:** Define Interface
- [ ] **Etapa 2:** Create Store Service
```
You can now continue to the next stage by executing `/runplan stage 2`.

---

## 🔌 IDE Integration (Continue.dev)

Configure REI as your local-first repository-aware provider inside **Continue** (VS Code / JetBrains):

1. **Start the REI Server:**
   ```bash
   ~/.rei/rei-server
   ```
2. **Configure `config.json` in Continue:**
   Add a custom model pointing to the REI endpoint:
   ```json
   {
     "models": [
       {
         "title": "REI Hybrid",
         "provider": "openai",
         "model": "qwen/qwen3.6-plus",
         "apiBase": "http://localhost:3000/chat/completions"
       }
     ]
   }
   ```

## Workspace resolution

REI resolves the workspace path differently depending on how it runs.

**CLI mode** — workspace is always one of:
- `process.cwd()` (default, no flags) — the directory where you ran `rei chat`
- `--workspace /path/to/repo` — explicit override at launch time

`REI_WORKSPACE_PATH` has no effect in CLI mode.

**Server mode** — two environment variables control workspace access:

- `REI_WORKSPACE_PATH`: the default workspace the server operates on. Falls back to `process.cwd()` if not set.
- `ALLOWED_WORKSPACES`: comma-separated security whitelist. The server rejects any workspace not in this list. Falls back to `process.cwd()` if not set.

```bash
REI_WORKSPACE_PATH=/Users/you/my-project \
ALLOWED_WORKSPACES=/Users/you/my-project,/Users/you/another-project \
rei-server
```

The server validates every incoming request against `ALLOWED_WORKSPACES`. Requests targeting unlisted paths are rejected with a `403`.

### Interactive commands

| Command | Description |
|---|---|
| `/help` | Show available commands |
| `/clear` | Clear conversation history |
| `/exit` | End the session |
| `/mode ask` | Switch to ask mode |
| `/mode planning` | Switch to planning mode |
| `/mode agent` | Switch to agent mode |
| `/index` | Build or refresh the semantic index file (legacy/optional; runtime context currently uses heuristics) |
| `/compact` | Manually compact conversation memory into a summary |
| `/session` | Show current session info (created date, mode, turn count) |
| `/session list` | List all archived sessions for this workspace |
| `/session load <id>` | Load an archived session by ID |
| `/session new` | Archive the current session and start a fresh one |

## Modes

REI has three response modes:

- `ask`: explanation and Q&A. Returns a normal text answer.
- `planning`: analysis and implementation planning. Returns a normal text answer.
- `agent`: repository-aware agent flow. Internally performs a context decision step, may ask for more file content, and then returns a normal markdown answer.

The active mode can be changed during a chat session with `/mode <mode>`.

## Model providers

Provider selection is controlled by `MODEL_PROVIDER`:

- `MODEL_PROVIDER=mock`
- `MODEL_PROVIDER=ollama`
- `MODEL_PROVIDER=groq`
- `MODEL_PROVIDER=gemini`
- `MODEL_PROVIDER=openrouter`

### Ollama setup

1. Install Ollama:

```bash
curl -fsSL https://ollama.com/install.sh | sh
```

2. Start the server:

```bash
ollama serve
```

3. Pull a model:

```bash
ollama pull llama3.2
```

4. Run REI:

```bash
MODEL_PROVIDER=ollama OLLAMA_MODEL=llama3.2 rei chat
```

Optional configuration:

- `OLLAMA_BASE_URL` default: `http://127.0.0.1:11434`
- `OLLAMA_MODEL` default: `llama3.2`
- `OLLAMA_REQUEST_TIMEOUT_MS` default: `300000`
- `OLLAMA_KEEP_ALIVE` default: `30m`
- `OLLAMA_NUM_CTX` optional (example: `8192`)
- `OLLAMA_NUM_PREDICT` optional (example: `512`)
- `OLLAMA_NUM_THREAD` optional (example for Apple Silicon: `8`)

Performance tip for local Apple Silicon runs:

```bash
MODEL_PROVIDER=ollama \
OLLAMA_MODEL=qwen2.5-coder:7b \
OLLAMA_KEEP_ALIVE=2h \
OLLAMA_NUM_CTX=8192 \
OLLAMA_NUM_PREDICT=512 \
rei chat
```

### Compactor model (optional)

When conversation memory is compacted, REI can use a separate cheaper model for summarization instead of the main provider model. This is useful when the main model is expensive or slow.

```bash
COMPACTOR_MODEL=openai/gpt-4o-mini rei chat
```

If not set, the compactor uses the same provider and model as the main session.

### Gemini setup

1. Create an API key in Google AI Studio.
2. Run REI:

```bash
MODEL_PROVIDER=gemini GEMINI_API_KEY=your-key GEMINI_MODEL=gemini-2.5-flash rei chat
```

Optional configuration:

- `GEMINI_API_KEY` required
- `GEMINI_MODEL` default: `gemini-2.5-flash`
- `GEMINI_REQUEST_TIMEOUT_MS` default: `120000`

### OpenRouter setup

1. Create an API key at [openrouter.ai/keys](https://openrouter.ai/keys).
2. Run REI:

```bash
MODEL_PROVIDER=openrouter OPENROUTER_API_KEY=your-key rei chat
```

To use a specific model:

```bash
MODEL_PROVIDER=openrouter OPENROUTER_API_KEY=your-key OPENROUTER_MODEL=anthropic/claude-3.5-sonnet rei chat
```

Optional configuration:

- `OPENROUTER_API_KEY` required
- `OPENROUTER_MODEL` default: `openai/gpt-4o-mini`
- `OPENROUTER_REQUEST_TIMEOUT_MS` default: `120000`

### Multi-provider setup (different providers per mode)

REI can route each session mode to a different provider and model. The typical pattern is a fast local model for ask/planning and a more capable cloud model for agent edits.

Set `AGENT_MODEL_PROVIDER` to override the provider used only in agent mode. The default `MODEL_PROVIDER` continues to handle ask and planning.

The agent model is resolved as `<PROVIDER>_MODEL_AGENT`, falling back to the provider's base model if the `_AGENT` variant is not set.

**Example: Ollama (ask/planning) + OpenRouter (agent)**

```bash
# ask + planning: local Ollama, fast and free
MODEL_PROVIDER=ollama
OLLAMA_MODEL=qwen2.5-coder:14b
OLLAMA_MODEL_ASK=qwen2.5-coder:14b
OLLAMA_MODEL_PLANNING=qwen2.5-coder:14b
OLLAMA_NUM_CTX=32768

# agent: OpenRouter, more capable for XML edits
AGENT_MODEL_PROVIDER=openrouter
OPENROUTER_API_KEY=your-key
OPENROUTER_MODEL_AGENT=google/gemma-4-31b-it
```

All providers support the `_AGENT` model suffix: `OPENROUTER_MODEL_AGENT`, `OLLAMA_MODEL_AGENT`, `GROQ_MODEL_AGENT`, `GEMINI_MODEL_AGENT`, `HF_MODEL_AGENT`.

### Per-mode model overrides (Ollama single-provider)

When using Ollama as the sole provider, each mode can use a different model:

```bash
MODEL_PROVIDER=ollama
OLLAMA_MODEL=qwen2.5-coder:14b       # fallback for all modes
OLLAMA_MODEL_ASK=gemma3:12b          # fast, conversational
OLLAMA_MODEL_PLANNING=gemma3:12b     # fast, structured output
OLLAMA_MODEL_AGENT=qwen3:30b-a3b     # heavier model for XML edits
```

Per-mode overrides are only supported for Ollama in single-provider mode. For all other providers, use `AGENT_MODEL_PROVIDER` to assign a dedicated agent provider.

## Terminal output

The interactive chat runs in a full-screen terminal UI (alternate screen buffer) and renders the final answer as formatted markdown:

- headings with ANSI styling
- inline code formatting
- syntax-highlighted code blocks
- preserved markdown structure instead of raw token spam

Input and navigation UX:

- command palette for `/` commands with arrow selection
- `@` mention palette for workspace paths (`Tab` to complete)
- input history (`Up`/`Down`) and reverse search (`Ctrl+R`)
- transcript scrolling (`Ctrl+U`/`Ctrl+D`, `PageUp`/`PageDown`, `Shift+Up`/`Shift+Down`)
- `Esc` closes palettes/search and returns focus to the input

The spinner still runs while the model is generating, and the final formatted answer is printed when the turn completes.

## Repository-aware context

On every user turn, REI rebuilds and injects a rich context bundle into the last user message before calling the provider.

### Turn context pipeline

1. **Workspace scan** — file tree is scanned and cached for 30 seconds.
2. **Local Semantic RAG** — the user's query is embedded locally using `@xenova/transformers`. REI retrieves context using AST chunks, Cosine Similarity, and Adjacency Boosting to pull in relevant files and their dependencies.
3. **Caller graph discovery** — when the prompt implies a change, REI extracts symbol names and scans the workspace for every file that references them.
4. **External knowledge** — if the prompt triggers a known framework keyword, official docs are fetched and summarized.
5. **Enriched user message** — assembled with caller file previews, heuristic file previews, and external doc summaries.

If you include `@path/to/file` in your message, that path is matched during the heuristic step and the file is prioritised. Using `@` for a specific file is always the most reliable way to guarantee it ends up in context.

This context is regenerated on every turn. It is not a one-time snapshot.

### Preview sizes

REI uses different preview sizes depending on mode and user intent:

- default: `900` chars
- agent mode: `4000` chars
- explicit content requests: up to `20000` chars in agent mode

Explicit content requests include prompts such as "exact code", "código exacto", "full code", "contenido completo", or "all functions".

When a preview is cut, REI appends:

```text
... (truncated)
```

That marker is important for the agent decision step.

## Semantic RAG Engine

REI features a highly advanced, fully local RAG (Retrieval-Augmented Generation) pipeline:
- **Local Embeddings**: Uses `Xenova/all-MiniLM-L6-v2` via `@xenova/transformers` natively in Node.js. No API keys required, completely offline.
- **AST-Aware Chunking**: Uses `ts-morph` to intelligently chunk files by **Functions**, **Classes**, and **Interfaces** instead of blind character counts.
- **Multi-Level Relevance**: Uses Cosine Similarity combined with an **Adjacency Boost** (+0.15 score to dependencies of highly relevant files) to pull complete context graphs into the prompt.
- **Isolated Vector Store**: An ultra-fast, native JSON flat-file database stored at `.rei/rag-index.json`.
- **Real-Time Incremental Updates**: Uses `chokidar` to listen to file system changes, surgically updating the AST vector embeddings of modified files in milliseconds without requiring an agent restart.

See [Semantic RAG Architecture](docs/rag-architecture.md) for more details.

## Session persistence

REI automatically saves the current conversation to `.rei/sessions/current.json` after every turn. On next launch, the session is restored transparently.

### Session format

```json
{
  "version": 1,
  "workspace": "/path/to/project",
  "mode": "agent",
  "createdAt": "2026-04-01T00:00:00.000Z",
  "updatedAt": "2026-04-01T00:00:00.000Z",
  "messages": []
}
```

### Session commands

| Command | Description |
|---|---|
| `/session` | Show current session info |
| `/session list` | List all archived sessions for this workspace |
| `/session load <id>` | Restore an archived session |
| `/session new` | Archive current session and start fresh |

When you run `/session new`, the current session is copied to `.rei/sessions/<timestamp>.json` and a blank session starts.

## Conversation compaction

Long-running sessions accumulate history that eventually exceeds the provider's context window. REI compacts automatically when a session reaches **20 non-system messages**.

### How it works

- The last **8 turns** are kept verbatim (recent context preserved exactly).
- All older turns are summarized into a single synthetic `assistant` message using the configured compactor model.
- The compacted session replaces the in-memory history and is saved to disk.

### Triggering manually

```bash
/compact
```

### Compactor model

```bash
COMPACTOR_MODEL=openai/gpt-4o-mini npm run dev -- chat
```

If `COMPACTOR_MODEL` is not set, the main session provider and model are used.

## External Knowledge Layer

REI features a zero-dependency layer to fetch official documentation when the local model lacks specialized knowledge. This avoids hallucination on framework-specific APIs without needing a fine-tuned model.

### Explicit Intent Detection
To prevent accidental web searches and reduce latency, REI's web scraper only triggers when you explicitly request documentation (e.g., using `@docs`, `buscar en la web`) or ask a direct technical question (e.g., `¿cómo hago...?`) alongside framework-specific keywords.

### Web Fetching
REI runs concurrent separate queries via a lightweight DuckDuckGo Lite scraper. It targets exclusively official domains. Supported providers currently include:
- **Angular / NgRx / RxJS** (`angular.dev`, `ngrx.io`, `rxjs.dev`)
- **Spring Boot** (`spring.io`)
- **TypeScript** (`typescriptlang.org`)
- **Node.js** (`nodejs.org`)

### Injecting Context
The retrieved HTML pages are cleaned, evaluated, and synthesized using a background model summarizer. The summarized knowledge chunks are then invisibly injected into the main context bundle *before* the model answers the user. The interactive terminal UI displays a `Searching official docs...` spinner while the search resolves.

## Agent mode: current flow

Agent mode uses an iterative Search/Replace loop with explicit XML actions.

### Phase 1: model response parsing

For each loop turn, REI parses the model output for:

- `<request_files>path1, path2</request_files>` to request additional file context
- `<edit file="...">` blocks with `<search>` and `<replace>` to propose changes

### Phase 2: deterministic file injection

If the model requests files via `<request_files>`, REI resolves them without asking the model to guess paths.

Guardrails applied before any file is injected:

- only files already discovered during workspace scanning are allowed
- sensitive filenames and extensions are denied
- symlink escapes outside the workspace are denied
- duplicate requests are ignored
- file reads are capped

Resolved content is appended to the conversation and the loop continues.

### Phase 2.5: sandbox verification and repair
For change tasks, REI validates model-proposed edits in a temporary sandbox before they are shown as actionable:

- apply Search/Replace edits in sandbox
- run `npx tsc --noEmit --pretty false` (or configured verifier)
- parse diagnostics and feed them back to the model in retry loops

---

## Patch workflow

When REI is in agent mode and the model proposes file changes, edits go through a sandbox-first validation flow.

### 1. Edit generation

The model produces Search/Replace blocks (`<edit file="...">` with `<search>` and `<replace>`).

### 2. Sandbox validation

`src/tools/typescript-compile-check.ts` applies the proposed edits to a temporary sandbox copy and runs project verification (`npx tsc --noEmit --pretty false` by default).

If validation fails, diagnostics are fed back to the model for repair retries.

### 4. Edit application

`src/tools/patch-applier.ts` applies Search/Replace edits to the filesystem. After a successful real apply (`dryRun: false`, all entries applied), the queue is automatically cleared.

### Phase 3: final free-text answer

After the extra context is injected, REI performs the final provider call and returns a normal markdown answer.

Important properties of the final phase:

- no top-level JSON contract
- no user-visible orchestration object
- inspection tasks can show exact code from the visible context
- change-planning tasks can describe concrete edits and risks
- the final text is what the terminal renders and what the user sees

In other words:

- legacy internal JSON is no longer part of the active agent pipeline
- the visible answer comes from the final free-text provider call

## How REI decides it needs more context

The key signal is whether the currently visible preview is sufficient for the request.

Typical examples where REI should request more context:

- the user asks for exact code and the preview ends with `... (truncated)`
- the user asks to explain all functions in a file but only part of the file is visible
- the user asks for a modification plan that depends on code paths not yet visible

Typical examples where REI should answer immediately:

- the selected previews already include the relevant function or type in full
- the user asks a high-level question that does not require reading a whole file

## Message trimming

REI keeps full chat history in memory, but sends only a reduced window to the provider.

Current limits by mode:

- `ask`: last `14` non-system messages
- `planning`: last `10` non-system messages
- `agent`: last `10` non-system messages

The system message is always preserved.
Repository context is re-injected each turn, so trimming older turns does not remove workspace grounding.

## Prompt system

The main system prompt is built in two different ways:

### Regular modes

For `ask` and `planning`, `buildSystemMessage(mode)` composes:

1. shared base prompt
2. shared response rules
3. mode-specific prompt
4. mode-specific output format

### Agent mode

Agent mode uses `buildSystemMessage("agent")`, which loads shared base instructions, shared response rules, and `prompts/modes/agent.md`.

## Debug output

Each turn prints a brief context summary.

Example:

```text
[REI debug] Workspace: /path/to/project
[REI debug] Relevant files selected: 3
  - src/core/agent.ts (score: 6)
  - src/prompts/prompt-builder.ts (score: 4)
  - README.md (score: 2)
[REI debug] Agent requested files: src/foo.ts
[REI debug] Agent proposed 2 edits. Running sandbox validation...
```

## Current limitations

- model-proposed edits may still be rejected if sandbox validation fails
- if semantic indexing is re-enabled, rebuild the index after large refactors (`/index`)
- external knowledge providers cover a limited set of frameworks

## Next steps

Near-term priorities:

1. `/review` command — structured code review output (critical / warning / suggestion) per file or directory
2. make `@` mentions first-class context pins (always pre-loaded before heuristic scoring)
3. optional semantic indexing refresh flow (if re-enabled)
4. add richer patch diagnostics/fix suggestions when validation fails

## Diagnostic Traceability (Logging)

REI records every turn's internal operations to a zero-dependency append-only JSON Lines file located at `.rei/logs/agent-flow.jsonl`. 
Because Agent Mode has internal hidden loops (context request + sandbox repair), this log is vital for transparency. It records:
- The exact raw output from the LLM before action parsing.
- The external URLs scraped by the Knowledge Orchestrator.
- The exact raw strings of proposed Search/Replace edits.
- The TypeScript compiler errors caught during sandbox verification.

## Testing

REI uses **Vitest** for extreme execution speed and ESM compatibility. 

To run the unit test suites:
```bash
npm run test
```
To run in watch mode:
```bash
npm run test:watch
```
To run the test suite and generate a V8 coverage report:
```bash
npx vitest run --coverage
```
To trigger a full TypeScript type check without emitting:
```bash
npm run check
```

### RAG Effectiveness Evals

While Vitest covers deterministic application logic, REI also includes AI Evaluation scripts (Evals) to measure the semantic quality and effectiveness of the context engine and RAG retrieval pipeline.

To run the RAG diagnostic eval and inspect the Top-K retrieval accuracy:
```bash
npm run test:eval
```
This is particularly useful when tweaking the `searchRag` weights, model embeddings, or heuristic scoring.

## Runtime overview

```mermaid
flowchart TD
  A[User enters message] --> B[Build system prompt for current mode]
  B --> C[Local Semantic RAG & File Selector]
  C --> CG[Caller graph discovery]
  CG --> C2{Keywords match official docs?}
  C2 -->|Yes| C3[Fetch, rank, and summarize internet docs]
  C3 --> D[Enrich user message: docs + caller + file previews]
  C2 -->|No| D

  D --> SC{needsCompaction?}
  SC -->|Yes| SC2[Compact: summarize old turns]
  SC2 --> E{Mode is agent}
  SC -->|No| E

  E -->|No| F[Call provider and return normal text]
  E -->|Yes| G[Phase 1: parse model actions]
  G --> H{Model requested files?}
  H -->|Yes| I[Phase 2: resolve requested files safely]
  I --> J[Inject requested file context and continue]
  H -->|No| J
  J --> K[Phase 2.5: validate and recover Search/Replace edits]
  K --> L[Phase 3: final free-text markdown answer]
  L --> M[Render formatted output in terminal]
  F --> M
```

## Agent loop and skills

Current skill activation is explicit, not generic.

- `planningSkill` is invoked directly by the `plan` CLI command.
- `src/skills/weather/SKILL.md` exists in the repository, but it is not auto-dispatched by the current chat or agent runtime.

```mermaid
flowchart TD
  A[User input] --> B{CLI command}

  B -->|plan| C[run-cli.ts]
  C --> D[planningSkill<br/>agent task]
  D --> E[agent.run<br/>prompt]
  E --> F[Provider<br/>complete]
  F --> G[Planning output]

  B -->|chat| H[run-chat.ts]
  H --> HS[Load session<br/>from disk]
  HS --> I{Session mode}

  I -->|ask/planning| J[buildSystemMessage]
  J --> K[buildTurnContext<br/>heuristic + caller graph]
  K --> L[provider chat/stream]
  L --> LS[Save session<br/>to disk]
  LS --> M[Rendered answer]

  I -->|agent| N[buildTurnContext<br/>heuristic + caller graph]
  N --> O[generateAgentModeResponse]
  O --> P[Parse model actions<br/>request_files or edit]
  P --> Q[Resolve requested files safely]
  Q --> R[Phase 2.5 sandbox validation + repair loop]
  R --> S[Final model response]
  S --> SLS[Save session<br/>to disk]
  SLS --> T{Valid edits?}
  T -->|Yes| U[Answer + patch section]
  T -->|No| U

  style V fill:#f0f0f0,stroke:#999
  V[src/skills/weather/SKILL.md - exists not active]
```

## Documentation rule

When core runtime behavior changes, update the README in the same change set.

## Contributing

We welcome community contributions! REI is heavily optimized for TypeScript/JavaScript, and our biggest goal is to expand this strict, AST-driven philosophy to other languages using `Tree-sitter`. 

Please read our [CONTRIBUTING.md](CONTRIBUTING.md) for details on our code of conduct, and the process for submitting pull requests to us.

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
