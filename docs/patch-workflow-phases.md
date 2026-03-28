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

## Phase 2: Patch Generation

Implemented in src/tools/patch-generator.ts:

- generateUnifiedDiff(filePath, before, after)
- formatPatchForTerminal(diffText)
- extractFileFromPatch(diffText)

This phase is used both for direct diff handling and for synthesized edits that REI converts into a unified diff before validation.

---

## Phase 3: Patch Validation

Implemented in src/tools/patch-validator.ts:

- validatePatchSemantics(patchText)
- validatePatchWithGit(patchText, workspacePath)
- detectMergeConflicts(patchText)
- validatePatchProposal(proposal, workspacePath, policy?)

Validation stages:

1. Semantic validation checks diff structure, hunks, and conflict markers.
2. Security validation checks the target file against workspace policy.
3. Git applicability runs git apply --check without writing to disk.

Only patches that pass all stages can enter the pending queue.

---

## Phase 4: Patch Application

Implemented in src/tools/patch-applier.ts:

- applyPatchToFS(patchText, workspacePath, options?)
- applyPatchBatch(proposals, workspacePath, options?)
- commitAppliedPatches(workspacePath, message, filePaths?)

Active CLI behavior:

1. /confirm --dry-run re-validates and runs git apply --check only.
2. /confirm applies validated patches with git apply.
3. If every patch applies successfully in a real run, the queue is cleared.

Important:

- commitAppliedPatches exists as a helper, but it is not part of the default interactive CLI flow.

---

## Phase 5: AgentDecision Extension

Implemented in src/contracts/agent-decision.types.ts and src/agent-mode/generator.ts.

The decision contract supports:

- ready
- taskType
- contextRequests
- proposedPatches

Current generator behavior:

- validates proposedPatches returned by the decision phase
- normalizes headers, paths, and escaped newlines before validation
- retries some invalid patches through a critic loop
- can synthesize search/replace edits from visible context and convert them into diffs
- returns valid proposed patches to the Agent queue
- appends a patch section to the final answer when relevant

This means patch generation is no longer just a passive model output; REI actively repairs and validates patch proposals before surfacing them as actionable.

---

## Phase 6: CLI Confirmation Gate

Implemented in src/cli/run-chat.ts.

Available commands:

- /pending - display queued patches with ANSI-colored diffs
- /confirm - apply queued patches
- /confirm --dry-run - validate queued patches without writing
- /discard - clear queued patches

Display behavior from formatPatchForTerminal:

- Green additions
- Red deletions
- Cyan file headers
- Yellow hunk headers

---

## End-to-End Flow

```text
User message
  -> Agent decision (may include proposedPatches)
  -> Context resolution for approved file requests
  -> Patch normalization / validation / recovery
  -> Queue valid patches on Agent
  -> /pending to inspect
  -> /confirm or /confirm --dry-run
```

For change-planning tasks, Phase 2.5 in the runtime effectively sits between context resolution and the final answer:

- patch normalization
- semantic validation
- security validation
- git apply --check
- retry / synthesis when possible

---

## Risk Mitigation

| Risk | Mitigation |
|------|-----------|
| Path traversal escapes | Target validation keeps paths inside the workspace |
| Symlink breakouts | Real-path containment checks reject escapes |
| Corrupted diffs | Validation runs git apply --check before queue/apply |
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

Step 1 - Agent Decision
  Output: AgentDecision { ready, taskType, contextRequests, proposedPatches? }

  ↓ if contextRequests exist

Step 2 - Context Resolution
  Resolve only scanned workspace files
  Reject denied files, sensitive extensions, and symlink escapes

  ↓ if proposedPatches exist

Step 3 - Patch Normalization / Generation
  Normalize headers, canonical paths, escaped newlines
  Generate unified diffs for synthesized edits

  ↓

Step 4 - Patch Validation / Recovery
  validatePatchSemantics() + validatePatchWithGit()
  Retry repairable failures through the critic loop
  Queue valid proposals on Agent.pendingProposedPatches

  ↓ after /confirm

Step 5 - Patch Application
  applyPatchToFS(dryRun=true) for /confirm --dry-run
  applyPatchToFS(dryRun=false) for /confirm

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
  N --> O[prepareAgentContext()]
  O --> P[Phase 1 decision]
  P --> Q[Phase 2 context resolution]
  Q --> R[Phase 2.5 patch validation and recovery]
  R --> S[Final provider call]
  S --> T[Queue valid patches if any]
  T --> U[Rendered answer plus patch section]

  V[weather/SKILL.md] -. skill file exists in repo .-> W[No runtime activation yet]
  W -. not connected to chat or agent dispatch .-> H
```

Notes:

- The agent loop currently does not include a general skill router.
- `planningSkill` is a direct TypeScript wrapper, not a prompt-file skill loaded dynamically.
- `weather/SKILL.md` documents a capability, but the current CLI/runtime does not inspect user intent and auto-dispatch to it.

