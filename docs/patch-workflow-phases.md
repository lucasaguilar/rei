# Patch Workflow - Current Implementation

## Vision

REI allows agent mode to propose concrete patches, validate them safely, queue them for review, and apply them only after an explicit CLI confirmation step.

## Status

All six patch-workflow phases are implemented.

The active runtime flow is:

1. Agent mode evaluates whether the visible context is enough and may emit proposed patches.
2. Additional files are resolved safely from the scanned workspace only.
3. Proposed patches are normalized, validated, and optionally repaired.
4. Valid patches are queued on the Agent instance.
5. The CLI exposes review and confirmation commands.

---

## Phase 1: Security Layer

What's implemented:

- src/workspace/file-security.ts validates workspace containment.
- Directory allowlists are enforced.
- Denied files such as package metadata, lockfiles, and env files are blocked.
- Symlink traversal is rejected.

Security policy summary:

- Allowed dirs: ["src/", "prompts/", "docs/"]
- Denied files include package.json, tsconfig.json, .env, and lockfiles.
- Symlink escapes are denied.

---

## Phase 2: Edit Generation (Search & Replace)

Implemented in src/agent-mode/response-handler.ts:

- extractSREdits(response)
- extractFileRequests(response)
- buildAgentRepairPrompt(...)

The agent emits `<edit file="...">` blocks with `<search>` / `<replace>` pairs.

---

## Phase 3: Sandbox Validation

Implemented in src/tools/typescript-compile-check.ts and src/agent-mode/generator.ts.

Validation stages:

1. Apply all proposed Search/Replace edits to a temporary sandbox workspace.
2. Run project verification command (`npx tsc --noEmit --pretty false` by default).
3. Parse diagnostics and feed failures back into the repair loop.

Only edits that pass sandbox verification are queued.

---

## Phase 4: Patch Application

Implemented in src/tools/patch-applier.ts:

- applySREditBatchFS(edits, workspacePath, options?)

Active CLI behavior:

1. /confirm --dry-run validates Search/Replace applicability without writing.
2. /confirm applies queued Search/Replace edits to the filesystem.
3. If every edit applies successfully in a real run, the queue is cleared.

Important:

- Application is edit-based (Search/Replace), not unified-diff based.

---

## Phase 5: AgentDecision Extension

Implemented in src/agent-mode/generator.ts.

Current generator behavior:

- extracts search/replace edits from model output
- handles `<request_files>` cycles when more context is needed
- retries invalid edits through a repair loop using sandbox diagnostics
- returns sandbox-verified edits to the Agent queue

---

## Phase 6: CLI Confirmation Gate

Implemented in src/cli/run-chat.ts.

Available commands:

- /pending - display queued edits
- /confirm - apply queued edits
- /confirm --dry-run - validate queued edits without writing
- /discard - clear queued patches

Display behavior shows file targets and edit blocks for queued Search/Replace operations.

---

## End-to-End Flow

```text
User message
  -> Agent generates search/replace edits or requests files
  -> Context resolution for approved file requests
  -> Sandbox validation / repair loop
  -> Queue valid edits on Agent
  -> /pending to inspect
  -> /confirm or /confirm --dry-run
```

For change tasks, runtime validation sits between context resolution and the final answer:

- search/replace applicability
- sandbox project verification
- compile diagnostics feedback loop

---

## Risk Mitigation

| Risk | Mitigation |
|------|-----------|
| Path traversal escapes | Target validation keeps paths inside the workspace |
| Symlink breakouts | Real-path containment checks reject escapes |
| Corrupted edit payloads | Search/Replace validation rejects malformed or non-matching edits |
| Unsafe targets | Denylists and directory policy block sensitive files |
| Accidental writes | The CLI requires explicit /confirm |
| Hidden auto-commit behavior | Commits are not automatic in the CLI flow |

---

## How To Exercise The Flow

```bash
npm run dev -- chat
```

Inside the REI session:

```text
/mode agent
implement feature X in src/foo.ts
/pending
/confirm --dry-run
/confirm
/discard
```

---

## Architecture Diagram

The runtime steps below map to the implemented phases above.

```text
┌──────────────────────────────────────────────────────────────┐
│ Agent Mode: 4-Phase + Patch Workflow                        │
└──────────────────────────────────────────────────────────────┘

Step 1 - File Resolution
  Model emits <request_files>path1, path2</request_files> XML tags
  System resolves only scanned workspace files
  Reject denied files, sensitive extensions, and symlink escapes

  ↓ files injected into next model message

Step 2 - Edit Generation
  Model emits <edit file="..."><search>...</search><replace>...</replace></edit> blocks
  Normalize Search/Replace payloads and paths
  Prepare batch edits for sandbox validation

  ↓

Step 4 - Sandbox Validation / Recovery
  Apply Search/Replace edits in temporary sandbox
  Run project verification (tsc by default)
  Retry repairable apply/compile failures through repair loop
  Queue valid edits on Agent.pendingProposedPatches

  ↓ after /confirm

Step 5 - Edit Application
  applySREditBatchFS(dryRun=true) for /confirm --dry-run
  applySREditBatchFS(dryRun=false) for /confirm

  ↓ in CLI loop

Step 6 - Confirmation Gate
  /pending
  /confirm
  /confirm --dry-run
  /discard
```

---

## Agent Loop And Skill Activation

The current repository has two different skill-related paths:

- planningSkill is actively invoked by the CLI `plan` command.
- weather/SKILL.md exists as a skill asset, but it is not currently auto-activated anywhere in the runtime chat or agent loop.

```mermaid
flowchart TD
  A[User input] --> B{CLI command}

  B -->|plan| C[run-cli.ts]
  C --> D[planningSkill(agent, task)]
  D --> E[agent.run(prompt)]
  E --> F[Provider complete()]
  F --> G[Planning output]

  B -->|chat| H[run-chat.ts]
  H --> I{Session mode}

  I -->|ask/planning| J[buildSystemMessage(mode)]
  J --> K[buildTurnContext()]
  K --> L[provider.completeChat or streamChat]
  L --> M[Rendered answer]

  I -->|agent| N[buildTurnContext()]
  N --> O[generateAgentModeResponse()]
  O --> P[Parse model actions: request_files or edit]
  P --> Q[Phase 2 context resolution]
  Q --> R[Phase 2.5 sandbox validation and recovery]
  R --> S[Final model response]
  S --> T[Queue valid edits if any]
  T --> U[Rendered answer plus patch section]

  V[weather/SKILL.md] -. skill file exists in repo .-> W[No runtime activation yet]
  W -. not connected to chat or agent dispatch .-> H
```

Notes:

- The agent loop currently does not include a general skill router.
- `planningSkill` is a direct TypeScript wrapper, not a prompt-file skill loaded dynamically.
- `weather/SKILL.md` documents a capability, but the current CLI/runtime does not inspect user intent and auto-dispatch to it.

