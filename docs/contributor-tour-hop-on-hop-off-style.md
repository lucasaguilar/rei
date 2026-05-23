# REI Contributor Tour Guide (Hop-On Hop-Off)

This guide is for contributors who want to understand how REI works end to end without being TypeScript experts.

The format is a hop-on hop-off route:

- Hop on at the project entrypoints.
- Jump to the subsystem you need.
- Hop off with a clear contribution path.

---

## Route Summary

1. Stop 1: CLI startup and workspace resolution
2. Stop 2: Chat UI and user input flow
3. Stop 3: Turn context building (repo, RAG, caller graph, docs)
4. Stop 4: Mode behavior (ask, planning, agent)
5. Stop 5: Agent edit pipeline (request files, validate, apply)
6. Stop 6: Built-in tools & interception (weather, command execution)
7. Stop 7: Example walk-through: add sum command to cliCalc
8. Stop 8: How to add support for a new language

---

## Stop 1: CLI Startup and Workspace Resolution

Primary entry chain:

- [../bin/rei.js](../bin/rei.js)
- [../src/main.ts](../src/main.ts)
- [../src/cli/run-cli.ts](../src/cli/run-cli.ts)

What happens here:

1. REI reads command-line args.
2. It resolves target workspace from --workspace or current directory.
3. It validates the workspace exists and is a directory.
4. It creates a model provider from [../src/providers/provider-factory.ts](../src/providers/provider-factory.ts).
5. It creates the core agent from [../src/core/agent.ts](../src/core/agent.ts).
6. It routes to plan or chat.

If user only sets --workspace and no command, it defaults to chat behavior in [../src/cli/run-cli.ts](../src/cli/run-cli.ts).

---

## Stop 2: Chat UI and User Input Flow

Chat runtime starts in:

- [../src/cli/run-chat.ts](../src/cli/run-chat.ts)

Session and UX support:

- Session persistence: [../src/chat/session-store.ts](../src/chat/session-store.ts)
- Keyboard handling: [../src/cli/ui/keyboard-handler.ts](../src/cli/ui/keyboard-handler.ts)
- Input submission: [../src/cli/ui/input-handler.ts](../src/cli/ui/input-handler.ts)
- Command routing: [../src/cli/helpers/input-command.helpers.ts](../src/cli/helpers/input-command.helpers.ts)
- Normal prompt turns: [../src/cli/helpers/input-turn.helpers.ts](../src/cli/helpers/input-turn.helpers.ts)
- Slash command logic: [../src/chat/menu-command-processor.ts](../src/chat/menu-command-processor.ts)

What happens here:

1. REI loads or creates current session.
2. It initializes interactive terminal UI.
3. It handles slash commands like /mode, /index, /compact.
4. It sends normal prompts to the agent streaming turn pipeline.

On first run, RAG indexing can start in background through:

- [../src/context/rag/rag-indexer.ts](../src/context/rag/rag-indexer.ts)

---

## Stop 3: Turn Context Building

Every normal prompt builds a fresh turn context in:

- [../src/context/context-builder.ts](../src/context/context-builder.ts)

Related components:

- Workspace scan: [../src/workspace/workspace-scanner.ts](../src/workspace/workspace-scanner.ts)
- Relevant file ranking: [../src/workspace/file-selector.ts](../src/workspace/file-selector.ts)
- File preview loading: [../src/workspace/file-preview.ts](../src/workspace/file-preview.ts)
- Caller graph discovery: [../src/context/caller-graph.ts](../src/context/caller-graph.ts)
- RAG index/search: [../src/context/rag/rag-indexer.ts](../src/context/rag/rag-indexer.ts)
- Vector storage: [../src/context/rag/vector-store.ts](../src/context/rag/vector-store.ts)
- External docs knowledge: [../src/knowledge/orchestrator.ts](../src/knowledge/orchestrator.ts)
- Turn message injection: [../src/core/helpers/turn-message.helpers.ts](../src/core/helpers/turn-message.helpers.ts)

Prompt assembly and mode policies:

- Builder: [../src/prompts/prompt-builder.ts](../src/prompts/prompt-builder.ts)
- Loader: [../src/prompts/loader.ts](../src/prompts/loader.ts)
- Shared base rules: [../prompts/shared/base.md](../prompts/shared/base.md)
- Shared response rules: [../prompts/shared/response-rules.md](../prompts/shared/response-rules.md)
- Ask mode: [../prompts/modes/ask.md](../prompts/modes/ask.md)
- Planning mode: [../prompts/modes/planning.md](../prompts/modes/planning.md)
- Agent mode: [../prompts/modes/agent.md](../prompts/modes/agent.md)

Important detail:

- Turn messages are enriched each time, so context is regenerated per prompt, not one-time loaded.

---

## Stop 4: Mode Behavior

Session mode type lives in:

- [../src/chat/types.ts](../src/chat/types.ts)

Main runtime in:

- [../src/core/agent.ts](../src/core/agent.ts)

Mode behavior:

1. ask: answer and explain, no action contract expected.
2. planning: produce implementation plans, no file edits expected.
3. agent: execute XML action loop for request_files, edit, create, and optional command execution.

Message window trimming for model context budget:

- [../src/chat/message-builder.ts](../src/chat/message-builder.ts)

Compaction when session grows:

- [../src/chat/compactor.ts](../src/chat/compactor.ts)

---

## Stop 5: Agent Edit Pipeline

Core loop:

- [../src/agent-mode/generator.ts](../src/agent-mode/generator.ts)

XML extraction:

- [../src/agent-mode/response-handler.ts](../src/agent-mode/response-handler.ts)

Validation and apply path:

- Sandbox validation: [../src/tools/typescript-compile-check.ts](../src/tools/typescript-compile-check.ts)
- Search/replace logic: [../src/tools/search-replace.ts](../src/tools/search-replace.ts)
- Filesystem apply: [../src/tools/patch-applier.ts](../src/tools/patch-applier.ts)
- Command execution guardrails: [../src/tools/command-executor.ts](../src/tools/command-executor.ts)

Observability:

- Agent flow logs: [../src/core/logger.ts](../src/core/logger.ts)

Important details:

1. Agent edits are validated in a temporary sandbox before filesystem apply.
2. Search block matching is exact and must be unique.
3. The loop can auto-repair by feeding validation errors back to the model.

---

## Stop 6: Built-in Tools & Interception

REI supports built-in tool calls that are intercepted during the agent loop before patch application.

Tool invocation pattern:
- `<call_tool name="weather">Santa Fe, Argentina</call_tool>`
- `<call_tool name="weather">{"location": "London"}</call_tool>`

Implementation:
- Extraction: [../src/agent-mode/response-handler.ts](../src/agent-mode/response-handler.ts) (`extractToolCalls`)
- Execution: [../src/core/agent.ts](../src/core/agent.ts) (intercepts `weather` calls in `streamTurn` and `generateAgentAssistantResponse`)
- Logic: [../src/tools/weather-tool.ts](../src/tools/weather-tool.ts) (`getWeather` using wttr.in API)

When a tool call is detected, REI executes it, appends the result to the conversation as `System Feedback`, and continues the turn. This allows the model to use real-time data without leaving the chat context.

---

## Stop 7: Example Walk-Through

### Scenario

User points REI to a simple TypeScript project (for example, cliCalc) and asks:

- add sum command to cliCalc

### Step A: User starts CLI for a specific project

Example command pattern:

    rei --workspace C:/dev/cliCalc chat

Software workflow:

1. [../bin/rei.js](../bin/rei.js) loads built runtime.
2. [../src/main.ts](../src/main.ts) forwards CLI args.
3. [../src/cli/run-cli.ts](../src/cli/run-cli.ts) resolves workspace, validates it, creates provider and agent.
4. [../src/cli/run-chat.ts](../src/cli/run-chat.ts) loads session and starts terminal UI.
5. If needed, [../src/context/rag/rag-indexer.ts](../src/context/rag/rag-indexer.ts) starts indexing.

### Step B: User prompt arrives

Input workflow:

1. Key input is captured in [../src/cli/ui/keyboard-handler.ts](../src/cli/ui/keyboard-handler.ts).
2. Submission is handled in [../src/cli/ui/input-handler.ts](../src/cli/ui/input-handler.ts).
3. Non-command prompt goes to [../src/cli/helpers/input-turn.helpers.ts](../src/cli/helpers/input-turn.helpers.ts).
4. Agent streaming turn runs in [../src/core/agent.ts](../src/core/agent.ts).

### Step C: What happens inside software

1. System prompt and mode instructions are assembled.
2. Relevant repository context is built (files, caller hints, RAG, optional docs).
3. Provider is called.
4. If mode is ask/planning, REI returns explanation or plan.
5. If mode is agent, REI may request more files, propose edits, validate, and apply.

Practical note for contributors:

- If you expect actual file modifications for this prompt, ensure mode is agent using slash command flow in [../src/chat/menu-command-processor.ts](../src/chat/menu-command-processor.ts).

---

## Stop 8: If a New Language Is Supported

Language capability registry starts here:

- [../src/language/language-capabilities.ts](../src/language/language-capabilities.ts)
- [../src/language/language.types.ts](../src/language/language.types.ts)

When adding a new language, update these points in order:

1. Add capability type and extensions.
2. Decide support level for:
   - AST indexing
   - Caller discovery
   - AST dependency extraction
   - Semantic validation
3. Ensure discovery and indexing include files:
   - [../src/workspace/workspace-scanner.ts](../src/workspace/workspace-scanner.ts)
   - [../src/tools/file-globber.ts](../src/tools/file-globber.ts)
4. Extend semantic chunking/index rules if needed:
   - [../src/context/rag/rag-indexer.ts](../src/context/rag/rag-indexer.ts)
5. Extend repository skeleton extraction if needed:
   - [../src/tools/repo-map-generator.ts](../src/tools/repo-map-generator.ts)
6. Extend caller detection strategy if needed:
   - [../src/context/caller-graph.ts](../src/context/caller-graph.ts)
7. Add project validation command for that ecosystem:
   - [../src/workspace/project-type.ts](../src/workspace/project-type.ts)
   - diagnostics parsing path in [../src/tools/typescript-compile-check.ts](../src/tools/typescript-compile-check.ts)

Contribution rule of thumb:

- Start with minimal support first (discovery plus generic semantic chunks), then incrementally add AST and language-specific validation.

---

## Optional Server Route (IDE Integration)

If you contribute to server mode, start here:

- [../src/server.ts](../src/server.ts)
- [../src/server/chat-handler.ts](../src/server/chat-handler.ts)
- [../src/server/workspace-config.ts](../src/server/workspace-config.ts)

This path exposes REI through a chat completions endpoint and reuses the same core agent flow.

---

## Deep-Dive Docs

- Prompt architecture: [prompt-architecture.md](prompt-architecture.md)
- RAG architecture: [rag-architecture.md](rag-architecture.md)
- Patch workflow phases: [patch-workflow-phases.md](patch-workflow-phases.md)

---

## Fast Contribution Entry Points

Choose one first contribution lane:

1. Prompt and mode behavior: [../src/prompts/prompt-builder.ts](../src/prompts/prompt-builder.ts) and [../prompts](../prompts)
2. Context quality and retrieval: [../src/context/context-builder.ts](../src/context/context-builder.ts)
3. Patch safety and validation: [../src/tools/typescript-compile-check.ts](../src/tools/typescript-compile-check.ts) and [../src/tools/patch-applier.ts](../src/tools/patch-applier.ts)
4. Language support expansion: [../src/language/language-capabilities.ts](../src/language/language-capabilities.ts)
