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

## Phase 2: Patch Generation (Not Started)

**Goal:** Generate unified diff format from before/after code.

**New Files:**
```
src/tools/patch-generator.ts
  - generateUnifiedDiff(filePath, before, after): string
  - formatPatchForTerminal(diff): AnsiFormatted
  - extractFileFromPatch(patch): {path, hunks}
```

**Integration Point:**
- Phase 1 validates file target
- Phase 2 generates actual diff text
- Output: Unified diff (RFC 3881 format)

**Dependencies:** None new (uses standard `diff` algorithms or Node.js built-ins)

---

## Phase 3: Patch Validation (Not Started)

**Goal:** Validate patches before showing to user.

**New Files:**
```
src/tools/patch-validator.ts
  - validatePatchWithGit(filePath, patch): {valid, conflicts?}
  - validatePatchSemantics(patch): {valid, fileExists?}
  - detectMergeConflicts(patch): string[]
```

**Checks:**
- Syntax: Valid unified diff format
- Semantics: Target file exists
- Applicability: Can `git apply --check` pass?
- Conflicts: Any merge markers or overlap?

---

## Phase 4: Patch Application (Not Started)

**Goal:** Apply patches to filesystem safely.

**New Files:**
```
src/tools/patch-applier.ts
  - applyPatchToFS(patches[], dryRun=true): {results}
  - commitPatch(message, patches): {sha}
```

**Flow:**
1. Dry-run: `git apply --check` on each patch
2. Real run: `git apply` to write to filesystem
3. Commit: Create commit with patch metadata

**Return:** Detailed results (success/fail per patch, affected lines)

---

## Phase 5: Extend AgentDecision Contract (Not Started)

**Goal:** Allow agents to propose patches in Phase 1 decision.

**Changes:**
```ts
// src/contracts/agent-decision.types.ts

interface AgentDecision {
  ready: boolean;
  taskType: "inspection" | "change-planning";
  contextRequests: ContextRequest[];
  
  // NEW:
  proposedPatches?: {
    file: string;  // e.g., "src/main.ts"
    description: string;  // e.g., "Add error handling to run()"
    patch: string;  // Unified diff format
  }[];
}
```

**When Used:**
- Phase 1 (decision): Model returns AgentDecision with patches
- Phase 2 (validation): Security + semantic checks run on patches
- Phase 3 (display): Patches shown in CLI with git diff colors

---

## Phase 6: CLI Confirmation Gate (Not Started)

**Goal:** Display patches to user, request confirmation, apply on approval.

**New/Modified Files:**
```
src/cli/run-chat.ts
  - Handle "/confirm" or "--apply-patches" command
  - Display patches with colors (red, green, context)
  - Request user confirmation
  - Call patch-applier on approval

src/cli/patch-display.ts (new)
  - Format patches to terminal with ANSI colors
  - Show file name, line numbers, before/after
  - Similar to `git diff --color-words`
```

**Flow:**
```
User message → Agent Phase 1 decision (with proposedPatches)
    ↓
Display patches in colored diff format:
  - Green: Addition (+)
  - Red: Deletion (-)
  - Cyan: File header
  - Yellow: Line numbers
    ↓
Prompt: "Apply these patches? [y/n]" or "Type /confirm to apply"
    ↓
[y] → Validate patches → Apply patches → Show results → Commit
[n] → Discard patches → Ask for clarification → Loop back to agent
```

---

## Implementation Order

| Phase | Feature | Est. LOC | Dependencies | Priority |
|-------|---------|---------|--------------|----------|
| **1** | **Security Layer** | **~210** | **fs, path** | **✅ DONE** |
| 2 | Patch Generation | ~150 | Phase 1 | High |
| 3 | Patch Validation | ~120 | Phase 1, 2 | High |
| 4 | Patch Application | ~100 | Phase 1, 2, 3 | Medium |
| 5 | AgentDecision Extension | ~30 | Phase 1-4 | Medium |
| 6 | CLI + Display | ~200 | Phase 1-5 | Medium |

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

### Phase 2 ⏳
- [ ] Create patch-generator.ts
- [ ] Implement generateUnifiedDiff()
- [ ] Add formatPatchForTerminal()
- [ ] Test with sample files
- [ ] TypeScript check passes

### Phase 3 ⏳
- [ ] Create patch-validator.ts
- [ ] Implement git apply --check wrapper
- [ ] Add conflict detection
- [ ] Test validation flow
- [ ] TypeScript check passes

### Phase 4 ⏳
- [ ] Create patch-applier.ts
- [ ] Implement dry-run logic
- [ ] Add commit logic
- [ ] Test on sample patches
- [ ] TypeScript check passes

### Phase 5 ⏳
- [ ] Update AgentDecision interface
- [ ] Update parser/serializer
- [ ] Update system prompts to mention patches
- [ ] Test contract serialization
- [ ] TypeScript check passes

### Phase 6 ⏳
- [ ] Add /confirm command
- [ ] Create patch display formatter
- [ ] Implement approval loop
- [ ] Test end-to-end flow
- [ ] E2E test with real agent

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

## Next: Phase 2

When ready to proceed:
```bash
# Create Phase 2 implementation
$ npm run check  # Verify all phases compile

# Then propose: "vamos con fase 2"
```

To skip phases or customize:
```
"salta fase 2, vamos con 3"
"solo fase 6, el display"
```

---

## Architecture Diagram

```
┌──────────────────────────────────────────────────────────────┐
│ Agent Mode: 3-Phase + Patch Workflow                          │
└──────────────────────────────────────────────────────────────┘

Phase 1 (Decision)
  System: agent-decision.md
  Output: AgentDecision {ready, taskType, contextRequests, proposedPatches?}

  ↓ If proposedPatches exist:

Phase 1.5 (Security) ← YOU ARE HERE (PHASE 1 COMPLETE)
  Validate: file-security.ts
  Run: validateFileTarget() on each patch.file
  
  ↓ If valid:

Phase 2 (Generation) ← NEXT
  Generate: patch-generator.ts
  Format: generateUnifiedDiff() for each file change
  
  ↓

Phase 3 (Validation) ← AFTER PHASE 2
  Validate: patch-validator.ts
  Check: git apply --check + conflict detection
  
  ↓ If valid:

Phase 4 (Application) ← AFTER PHASE 3
  Apply: patch-applier.ts
  Dry-run: Verify with git apply --check
  Real: git apply + commit
  
  ↓ Before showing to user:

Phase 5 (AgentDecision Extension) ← CONCURRENT WITH PHASES 2-4
  Update: agent-decision.types.ts
  Include: proposedPatches in contract
  
  ↓ In CLI loop:

Phase 6 (Confirmation Gate) ← AFTER ALL PREVIOUS
  Display: Colored diffs in terminal
  Confirm: Request /confirm from user
  Apply: Call patch-applier.ts on approval

┌──────────────────────────────────────────────────────────────┐
│ Phase 1 ✅ Security Layer Complete                             │
│ Validates: paths, containment, symlinks, readability          │
│ Ready for: Phase 2 (Patch Generation)                          │
└──────────────────────────────────────────────────────────────┘
```

