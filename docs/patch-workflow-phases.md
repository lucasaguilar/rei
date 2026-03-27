# Patch Workflow — 6-Phase Implementation Roadmap

## Vision

REI should allow agents to **propose concrete patches** to repository files, display them with a clear **confirmation gate**, and apply them safely with **security validation** and **git integration**.

## Current State: Phase 1 ✅ COMPLETE

**What's Done:**
- ✅ `src/workspace/file-security.ts` — Security validation layer
  - Workspace containment checks
  - Directory allowlist enforcement
  - File denylist protection
  - Symlink containment
  - Readability validation

**Files Created:**
- `src/workspace/file-security.ts` — Core security module (210 lines)
- `src/workspace/file-security.integration.ts` — Integration examples
- `docs/security-layer-phase-1.md` — Security documentation

**Compilation:** ✅ Clean

**Security Policy:**
- Allowed dirs: `["src/", "prompts/", "docs/"]`
- Denied files: `package.json`, `tsconfig.json`, `.env`, lock files, etc.
- Symlinks: Not allowed (containment)

---

## Phase 2: Patch Generation ✅ COMPLETE

**Goal:** Generate unified diff format from before/after code.

**Files Created:**
```
src/tools/patch-generator.ts
  - generateUnifiedDiff(filePath, before, after, options?): string
  - formatPatchForTerminal(diffText): string
  - extractFileFromPatch(diffText): ExtractedPatchInfo | null
```

**Integration Point:**
- Phase 1 validates file target
- Phase 2 generates actual diff text
- Output: Unified diff (RFC 3881 format)

**Dependencies:** `diff` npm package for `createTwoFilesPatch`

**Compilation:** ✅ Clean

---

## Phase 3: Patch Validation ✅ COMPLETE

**Goal:** Validate patches before showing to user.

**Files Created:**
```
src/tools/patch-validator.ts
  - validatePatchSemantics(patchText): PatchSemanticValidationResult
  - validatePatchWithGit(patchText, workspacePath): Promise<GitPatchValidationResult>
  - detectMergeConflicts(patchText): string[]
  - validatePatchProposal(proposal, workspacePath, policy?): Promise<PatchProposalValidationResult>
```

**Checks:**
- Syntax: Valid unified diff format with exactly one file header pair
- Semantics: Merge conflict marker detection, file target extraction
- Security: Runs Phase 1 `validateFileTarget()` on the patch target file
- Applicability: `git apply --check` with a temp file in a tmpdir

**Compilation:** ✅ Clean

---

## Phase 4: Patch Application ✅ COMPLETE

**Goal:** Apply patches to filesystem safely.

**Files Created:**
```
src/tools/patch-applier.ts
  - applyPatchToFS(patchText, workspacePath, options?): Promise<PatchApplyResult>
  - applyPatchBatch(proposals, workspacePath, options?): Promise<BatchPatchApplyResult>
  - commitAppliedPatches(workspacePath, message, filePaths?): Promise<{committed, stdout, stderr}>
```

**Flow:**
1. Dry-run: `git apply --check` on each patch
2. Real run: `git apply` to write to filesystem
3. Commit: `git add -- <files>` + `git commit` with patch metadata

**Return:** Detailed per-patch results (applied/skipped/failed, validation errors, stdout/stderr)

**Compilation:** ✅ Clean

---

## Phase 5: Extend AgentDecision Contract ✅ COMPLETE

**Goal:** Allow agents to propose patches in the decision phase.

**Modified Files:**
```
src/contracts/agent-decision.types.ts
  - Added AgentProposedPatch interface { file, description, patch }
  - Added proposedPatches?: AgentProposedPatch[] to AgentDecision

src/agent-mode/generator.ts
  - Validates proposedPatches from decision via validatePatchProposal()
  - Runs a patch-synthesis retry for change-planning tasks with no valid patches
  - Passes validProposedPatches back to Agent via AgentModeOutcome
  - Appends patch summary section to the final answer

src/core/agent.ts
  - Accumulates validProposedPatches into pendingProposedPatches queue
  - Exposes getPendingPatches() and clearPendingPatches() accessors
  - Exposes applyPendingPatches(options?) that calls applyPatchBatch()
```

**When Used:**
- Decision phase: Model returns AgentDecision with `proposedPatches`
- Validation phase (2.5): Security + semantic + `git apply --check` run on each patch
- Answer phase: Valid patches surfaced in response and queued on the Agent

**Compilation:** ✅ Clean

---

## Phase 6: CLI Confirmation Gate ✅ COMPLETE

**Goal:** Display patches to user, request confirmation, apply on approval.

**Modified Files:**
```
src/cli/run-chat.ts
  - /pending  — display queued patches with ANSI-colored diffs
  - /confirm  — apply queued patches via agent.applyPendingPatches()
  - /confirm --dry-run  — run git apply --check only, no filesystem writes
  - /discard  — clear the patch queue without applying
```

**Patch Display (formatPatchForTerminal in patch-generator.ts):**
- Green: Addition lines (+)
- Red: Deletion lines (-)
- Cyan: File headers (--- / +++)
- Yellow: Hunk headers (@@)

**Flow:**
```
User message → Agent decision (with proposedPatches)
    ↓
Phase 2.5: validate patches → queue valid ones on Agent
    ↓
/pending  → show colored diffs + "Use /confirm to apply"
    ↓
/confirm  → applyPatchBatch() → per-patch status (applied/skipped/failed)
/discard  → clear queue, return to conversation
```

---

## Implementation Order

| Phase | Feature | Est. LOC | Dependencies | Priority |
|-------|---------|---------|--------------|----------|
| **1** | **Security Layer** | **~210** | **fs, path** | **✅ DONE** |
| **2** | **Patch Generation** | **~112** | **Phase 1, diff** | **✅ DONE** |
| **3** | **Patch Validation** | **~227** | **Phase 1, 2** | **✅ DONE** |
| **4** | **Patch Application** | **~161** | **Phase 1, 2, 3** | **✅ DONE** |
| **5** | **AgentDecision Extension** | **~80** | **Phase 1-4** | **✅ DONE** |
| **6** | **CLI + Display** | **~70** | **Phase 1-5** | **✅ DONE** |

---

## Execution Checklist

### Phase 1 ✅
- [x] Create security module
- [x] Validate path containment
- [x] Implement denylist/allowlist
- [x] Symlink checks
- [x] File readability checks
- [x] Integration examples
- [x] TypeScript check passes

### Phase 2 ✅
- [x] Create patch-generator.ts
- [x] Implement generateUnifiedDiff()
- [x] Add formatPatchForTerminal()
- [x] Add extractFileFromPatch()
- [x] TypeScript check passes

### Phase 3 ✅
- [x] Create patch-validator.ts
- [x] Implement validatePatchSemantics()
- [x] Implement git apply --check wrapper (validatePatchWithGit)
- [x] Add conflict detection (detectMergeConflicts)
- [x] Add end-to-end validatePatchProposal()
- [x] TypeScript check passes

### Phase 4 ✅
- [x] Create patch-applier.ts
- [x] Implement applyPatchToFS() with dry-run support
- [x] Implement applyPatchBatch() with per-patch validation
- [x] Add commitAppliedPatches() with -- path separator hardening
- [x] TypeScript check passes

### Phase 5 ✅
- [x] Add AgentProposedPatch interface to agent-decision.types.ts
- [x] Add proposedPatches? field to AgentDecision
- [x] Wire patch validation into generator.ts (Phase 2.5)
- [x] Accumulate validProposedPatches in Agent queue
- [x] Expose getPendingPatches / clearPendingPatches / applyPendingPatches on Agent
- [x] TypeScript check passes

### Phase 6 ✅
- [x] Add /pending command (display queued patches with ANSI colors)
- [x] Add /confirm command (apply patches via applyPendingPatches)
- [x] Add /confirm --dry-run command (git apply --check only)
- [x] Add /discard command (clear patch queue)
- [x] TypeScript check passes

---

## Risk Mitigation

| Risk | Mitigation |
|------|-----------|
| Path traversal escapes | Phase 1 validates `isWithinWorkspace()` |
| Symlink breakouts | Phase 1 bans symlinks, checks entire path |
| Corrupted diffs | Phase 3 pre-validates with `git apply --check` |
| User accidentally applies | Phase 6 requires explicit `/confirm` command |
| Untracked changes lost | Phase 4 commits patches with metadata |
| Performance on large files | Phase 4 implements dryRun before real apply |

---

## All Phases Complete

The full patch workflow is implemented and active. To exercise the flow:
```bash
# Build and run REI in agent mode
npm run build
node dist/main.js --mode agent

# In the CLI session:
agent > implement feature X in src/foo.ts
# REI proposes patches, validates them, queues them

agent > /pending         # review queued patches with colored diffs
agent > /confirm         # apply patches to filesystem
agent > /confirm --dry-run  # dry-run only (no filesystem writes)
agent > /discard         # clear queue without applying
```

---

## Architecture Diagram

The runtime pipeline uses numbered *steps* that correspond to the implementation phases above.

```
┌──────────────────────────────────────────────────────────────┐
│ Agent Mode: 3-Phase + Patch Workflow  — ALL PHASES COMPLETE  │
└──────────────────────────────────────────────────────────────┘

Step 1 — Agent Decision
  System: agent-decision.md
  Output: AgentDecision {ready, taskType, contextRequests, proposedPatches?}

  ↓ If proposedPatches exist:

Step 2 — Security Check  (Phase 1: file-security.ts) ✅
  Validate: validateFileTarget() on each patch.file
  Rejects: out-of-workspace paths, denied files, symlinks
  
  ↓ If valid:

Step 3 — Patch Generation  (Phase 2: patch-generator.ts) ✅
  Generate: generateUnifiedDiff() for each file change
  
  ↓

Step 4 — Patch Validation  (Phase 3: patch-validator.ts) ✅
  Check: validatePatchSemantics() + validatePatchWithGit() (git apply --check)
  Queue: valid proposals onto Agent.pendingProposedPatches
  
  ↓ After /confirm:

Step 5 — Patch Application  (Phase 4: patch-applier.ts) ✅
  Dry-run: applyPatchToFS(dryRun=true) or /confirm --dry-run
  Real:    applyPatchToFS(dryRun=false) on /confirm
  Commit:  commitAppliedPatches() with -- path separator hardening
  
  ↓ In CLI loop (Phase 6: run-chat.ts) ✅:

Step 6 — CLI Confirmation Gate
  /pending        — display colored diffs (formatPatchForTerminal)
  /confirm        — apply queued patches via applyPendingPatches()
  /confirm --dry-run — git apply --check only
  /discard        — clear patch queue without applying

┌──────────────────────────────────────────────────────────────┐
│ All 6 phases complete. End-to-end patch workflow active.      │
└──────────────────────────────────────────────────────────────┘
```

