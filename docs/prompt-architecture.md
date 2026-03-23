# Prompt Architecture

This document explains how REI assembles system prompts, how to add new modes, and how to modify
behavior safely.

---

## Overview

REI uses a **hybrid prompt system**:

- **Markdown files** hold human-readable instructions that can be edited without touching TypeScript.
- **TypeScript orchestration** assembles the sections in the correct order and injects
  programmatic content (such as the agent JSON contract) that must stay machine-verifiable.

---

## File Layout

```
prompts/
  shared/
    base.md             ← Core identity and hallucination-prevention rules (all modes)
    response-rules.md   ← General response formatting rules (all modes)
  modes/
    ask.md              ← Instructions for ASK mode
    planning.md         ← Instructions for PLANNING mode
    agent.md            ← Instructions for AGENT mode
  formats/
    ask-format.md       ← Preferred response structure for ASK mode
    planning-format.md  ← Preferred response structure for PLANNING mode
    agent-format.md     ← Preferred response structure for AGENT mode

src/
  prompts/
    loader.ts           ← Reads markdown files from disk; in-memory cache
    prompt-builder.ts   ← Assembles sections; injects agent contract for agent mode
  contracts/
    agent-response.types.ts  ← TypeScript interface + JSON contract block builder

AGENTS.md               ← High-level description of REI, behavior rules, modes
```

---

## Prompt Assembly Order

For every mode the system prompt is built as:

```
[shared/base]
<blank line>
Active mode: <mode>
<blank line>
[shared/response-rules]
<blank line>
[modes/<mode>]
<blank line>
[agent contract block]   ← injected only when mode === "agent"
<blank line>             ← only when mode === "agent"
[formats/<mode>-format]
```

This is orchestrated by `buildSystemMessage(mode)` in `src/prompts/prompt-builder.ts`.

---

## Loader

`src/prompts/loader.ts` exposes one public function:

```ts
loadPrompt(section: string): string
```

- `section` is a path **relative to the `/prompts` root**, without the `.md` extension.
  - Examples: `"shared/base"`, `"modes/ask"`, `"formats/planning-format"`.
- Reads the file synchronously on first access; subsequent calls return the cached string.
- Call `clearPromptCache()` if you need to reload from disk (useful in tests).

---

## Agent JSON Contract

The agent contract is defined as a TypeScript interface in
`src/contracts/agent-response.types.ts`. It includes:

| Field             | Type                      | Description                                      |
|-------------------|---------------------------|--------------------------------------------------|
| `version`         | `"1.0"`                   | Schema version                                   |
| `mode`            | `"agent"`                 | Always `"agent"` for this contract               |
| `summary`         | `string`                  | One-sentence task interpretation                 |
| `confidence`      | `number` (0–1)            | Confidence in the proposed plan                  |
| `needsMoreContext`| `boolean`                 | Whether more context is needed                   |
| `contextRequests` | `AgentContextRequest[]`   | What context is missing and why                  |
| `actions`         | `AgentAction[]`           | Actions to perform (inspect / modify / validate) |
| `proposedChanges` | `AgentProposedChange[]`   | Concrete changes described (preview-first)       |
| `risks`           | `AgentRisk[]`             | Risks or concerns                                |
| `finalMessage`    | `string`                  | Human-readable response to the user              |

`buildAgentContractBlock()` serialises an example of this structure into a JSON code block that is
injected into the system prompt at runtime, so the model always sees the exact shape it should
produce.

---

## How to Add a New Mode

1. **Add the mode value** to `SessionMode` in `src/chat/types.ts`:
   ```ts
   export type SessionMode = "ask" | "planning" | "agent" | "your-mode";
   ```

2. **Create the instruction file** `prompts/modes/your-mode.md`.

3. **Create the format file** `prompts/formats/your-mode-format.md`.

4. **Update the CLI** — add the new mode to `MODE_PROMPTS` in `src/cli/run-chat.ts` and to the
   mode-switch validation in the same file.

5. **If the mode needs a special contract**, add the injection logic to `buildSystemMessage` in
   `src/prompts/prompt-builder.ts` (following the same pattern as the agent contract).

---

## How to Modify Behavior Safely

| Goal                                       | What to edit                                      |
|--------------------------------------------|---------------------------------------------------|
| Change wording of base identity rules      | `prompts/shared/base.md`                          |
| Change general response formatting rules   | `prompts/shared/response-rules.md`                |
| Change mode-specific behavior              | `prompts/modes/<mode>.md`                         |
| Change preferred response structure        | `prompts/formats/<mode>-format.md`                |
| Change agent JSON contract shape           | `src/contracts/agent-response.types.ts`           |
| Change assembly order                      | `src/prompts/prompt-builder.ts`                   |

Markdown files are loaded at runtime, so changes take effect on the next process start without
recompiling. TypeScript contract changes require a rebuild (`npm run check` validates types).
