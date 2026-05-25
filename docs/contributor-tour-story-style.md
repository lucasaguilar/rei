# Contributor Tour (Story Edition)

## The Story

Imagine your first day contributing to REI.

You open the terminal, point REI to a workspace, and hit enter.

The trip starts in [bin/rei.js](../bin/rei.js), jumps into [src/main.ts](../src/main.ts), and lands in [src/cli/run-cli.ts](../src/cli/run-cli.ts). That is where REI parses args, resolves workspace path, validates it, creates a provider through [src/providers/provider-factory.ts](../src/providers/provider-factory.ts), and builds the agent in [src/core/agent.ts](../src/core/agent.ts).

From there, the road splits.

If you run plan, it uses [src/skills/planning-skill.ts](../src/skills/planning-skill.ts).
If you run chat, it enters [src/cli/run-chat.ts](../src/cli/run-chat.ts), which is where most contributors spend their time.

Inside chat, REI restores conversation state with [src/chat/session-store.ts](../src/chat/session-store.ts), initializes mention helpers from [src/cli/helpers/chat.helpers.ts](../src/cli/helpers/chat.helpers.ts), and scans files via [src/workspace/workspace-scanner.ts](../src/workspace/workspace-scanner.ts). If no RAG index exists, background indexing begins through [src/context/rag/rag-indexer.ts](../src/context/rag/rag-indexer.ts).

Then the user starts typing.

Keystrokes pass through [src/cli/ui/keyboard-handler.ts](../src/cli/ui/keyboard-handler.ts), submissions are processed in [src/cli/ui/input-handler.ts](../src/cli/ui/input-handler.ts), and commands are routed by [src/cli/helpers/input-command.helpers.ts](../src/cli/helpers/input-command.helpers.ts) into [src/chat/menu-command-processor.ts](../src/chat/menu-command-processor.ts). Normal prompts run through [src/cli/helpers/input-turn.helpers.ts](../src/cli/helpers/input-turn.helpers.ts) and stream via the core agent.

Now REI has to think.

That logic lives in [src/core/agent.ts](../src/core/agent.ts). On each prompt, it assembles system instructions using [src/prompts/prompt-builder.ts](../src/prompts/prompt-builder.ts) and [src/prompts/loader.ts](../src/prompts/loader.ts), with mode rules from [prompts/modes/ask.md](../prompts/modes/ask.md), [prompts/modes/planning.md](../prompts/modes/planning.md), [prompts/modes/agent.md](../prompts/modes/agent.md), and shared rules from [prompts/shared/base.md](../prompts/shared/base.md) plus [prompts/shared/response-rules.md](../prompts/shared/response-rules.md).

It also builds turn context in [src/context/context-builder.ts](../src/context/context-builder.ts), combining ranking from [src/workspace/file-selector.ts](../src/workspace/file-selector.ts), caller discovery from [src/context/caller-graph.ts](../src/context/caller-graph.ts), RAG retrieval from [src/context/rag/rag-indexer.ts](../src/context/rag/rag-indexer.ts), external docs from [src/knowledge/orchestrator.ts](../src/knowledge/orchestrator.ts), previews from [src/workspace/file-preview.ts](../src/workspace/file-preview.ts), and message injection in [src/core/helpers/turn-message.helpers.ts](../src/core/helpers/turn-message.helpers.ts). To control token budget, history is trimmed by [src/chat/message-builder.ts](../src/chat/message-builder.ts).

After that, mode decides behavior.

In ask and planning, REI mostly returns explanations and plans.
In agent mode, the execution loop moves into [src/agent-mode/generator.ts](../src/agent-mode/generator.ts), parses XML actions in [src/agent-mode/response-handler.ts](../src/agent-mode/response-handler.ts), validates patches in sandbox via [src/tools/typescript-compile-check.ts](../src/tools/typescript-compile-check.ts), applies text edits using [src/tools/search-replace.ts](../src/tools/search-replace.ts), writes to filesystem through [src/tools/patch-applier.ts](../src/tools/patch-applier.ts), and can run allowed commands from [src/tools/command-executor.ts](../src/tools/command-executor.ts).

The whole trip is observable.

Sessions are stored in [src/chat/session-store.ts](../src/chat/session-store.ts), turn logs are emitted by [src/core/logger.ts](../src/core/logger.ts), repository skeletons come from [src/tools/repo-map-generator.ts](../src/tools/repo-map-generator.ts), and vectors are persisted by [src/context/rag/vector-store.ts](../src/context/rag/vector-store.ts).

---

## Built-in Tools & Interception

REI intercepts tool calls during the agent loop using the XML tag format `<call_tool name="name">args</call_tool>`.
Currently, the **Weather Tool** is implemented:
- Pattern: `<call_tool name="weather">City, Country</call_tool>`
- Extraction: [src/agent-mode/response-handler.ts](../src/agent-mode/response-handler.ts)
- Execution: [src/core/agent.ts](../src/core/agent.ts)
- Logic: [src/tools/weather-tool.ts](../src/tools/weather-tool.ts) (fetches data from wttr.in)

Results are injected back into the conversation as `System Feedback`, enabling the model to reason over live data.

---

## Walk-Through Example: add sum command to cliCalc

Step 1: User starts CLI on a target project.

Example command shape:

rei --workspace C:/dev/cliCalc chat

Flow: [bin/rei.js](../bin/rei.js) -> [src/main.ts](../src/main.ts) -> [src/cli/run-cli.ts](../src/cli/run-cli.ts) -> [src/cli/run-chat.ts](../src/cli/run-chat.ts).

Step 2: User sends prompt: add sum command to cliCalc.

Input flow: [src/cli/ui/input-handler.ts](../src/cli/ui/input-handler.ts) -> [src/cli/helpers/input-turn.helpers.ts](../src/cli/helpers/input-turn.helpers.ts) -> [src/core/agent.ts](../src/core/agent.ts).

Step 3: REI composes context and chooses behavior by mode.

If mode is ask, it explains.
If mode is planning, it proposes steps.
If mode is agent, it proposes edits, validates them in sandbox, and applies successful patches.

Important practical detail: if the contributor expects real code changes, they should switch to agent mode through [src/chat/menu-command-processor.ts](../src/chat/menu-command-processor.ts).

---

## High-Value Gotchas for Contributors

- Default chat mode starts in ask, so edit requests may not execute until mode changes in [src/chat/menu-command-processor.ts](../src/chat/menu-command-processor.ts).
- Caller discovery in [src/context/caller-graph.ts](../src/context/caller-graph.ts) is heuristic, so very short lowercase symbols can be under-detected.
- Workspace scanning in [src/workspace/workspace-scanner.ts](../src/workspace/workspace-scanner.ts) has a cap, so giant repos may not be fully scanned in one pass.
- Verification command selection is project-aware in [src/workspace/project-type.ts](../src/workspace/project-type.ts).
- Security policy definitions are in [src/workspace/file-security.ts](../src/workspace/file-security.ts), while the current apply path is centered in [src/tools/patch-applier.ts](../src/tools/patch-applier.ts).

Deep docs worth reading:

- [docs/prompt-architecture.md](../docs/prompt-architecture.md)
- [docs/rag-architecture.md](../docs/rag-architecture.md)
- [docs/patch-workflow-phases.md](../docs/patch-workflow-phases.md)

---

## If You Add a New Language

Start here:

- [src/language/language.types.ts](../src/language/language.types.ts)
- [src/language/language-capabilities.ts](../src/language/language-capabilities.ts)

Then update, in order:

1. Register extensions and capability flags.
2. Ensure files are discoverable by scanner and globber:
	- [src/workspace/workspace-scanner.ts](../src/workspace/workspace-scanner.ts)
	- [src/tools/file-globber.ts](../src/tools/file-globber.ts)
3. Decide minimal support vs first-class support:
	- Minimal: generic semantic chunks through [src/context/rag/rag-indexer.ts](../src/context/rag/rag-indexer.ts)
	- First-class: AST chunking plus skeleton rendering in [src/tools/repo-map-generator.ts](../src/tools/repo-map-generator.ts)
4. Extend caller logic if cascade-change safety is needed in [src/context/caller-graph.ts](../src/context/caller-graph.ts)
5. Add ecosystem verification command and diagnostics strategy:
	- [src/workspace/project-type.ts](../src/workspace/project-type.ts)
	- [src/tools/typescript-compile-check.ts](../src/tools/typescript-compile-check.ts)
6. Optional advanced step: language-specific dependency extraction in [src/context/ast-context.ts](../src/context/ast-context.ts)
7. Validate full contributor flow through [src/cli/run-cli.ts](../src/cli/run-cli.ts), [src/cli/run-chat.ts](../src/cli/run-chat.ts), and [src/core/agent.ts](../src/core/agent.ts)

---

## Optional Server Route

If your contribution is IDE/server integration, jump to:

- [src/server.ts](../src/server.ts)
- [src/server/chat-handler.ts](../src/server/chat-handler.ts)
- [src/server/workspace-config.ts](../src/server/workspace-config.ts)