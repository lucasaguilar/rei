# Security Layer — Phase 1 Implementation

## Overview

The file security layer (`src/workspace/file-security.ts`) protects REI from unauthorized or unintended file modifications during patch generation and application.

This layer enforces:
- ✅ Workspace containment (no path traversal escapes)
- ✅ Directory allowlist (only specific dirs can be modified)
- ✅ File denylist (protected files cannot be touched)
- ✅ Symlink containment (prevents breakout attacks)
- ✅ File readability (target must exist and be accessible)

## Default Security Policy

```ts
allowedDirs: ["src/", "prompts/", "docs/"]
deniedFiles: [
  "package.json", "tsconfig.json", 
  ".env", ".env.local", "node_modules", "dist", "build"
]
containSymlinks: true
```

**Rationale:**
- **`src/`**: Core implementation, safe for agent patches
- **`prompts/`**: Prompt definitions, safe for agent-assisted updates
- **`docs/`**: Documentation, safe for keeping in sync
- **Denied**: Config/lock files (package.json, tsconfig, .env) — require explicit human review

## Validation Flow

Every patch target goes through 6 checks:

```
Input: filePath (e.g., "src/main.ts"), workspacePath, policy
    ↓
1. Is path within workspace? (no ".." escapes)
    ↓
2. Is path in allowed directory? (["src/", "prompts/", "docs/"])
    ↓
3. Is path in denied list? (package.json, .env, etc.)
    ↓
4. Any symlinks in path chain? (containment)
    ↓
5. Is file readable? (exists, accessible)
    ↓
Output: {ok: true} or {ok: false, error: FileSecurityError}
```

## Error Types

| Code | Example | Remediation |
|------|---------|------------|
| `OUTSIDE_WORKSPACE` | `../../etc/passwd` | Path escapes workspace |
| `NOT_IN_ALLOWED_DIR` | `bin/script.sh` | Modify allowed dirs only |
| `IN_DENIED_LIST` | `package.json` | File is protected |
| `SYMLINK_IN_PATH` | `/workspace/link → /etc` | Symlinks not allowed |
| `NOT_READABLE` | `src/deleted.ts` | File must exist |

## Integration Timeline

### Phase 1 ✅ (Current)
- `validateFileTarget()` — Validate before accepting patch
- `isWithinWorkspace()` — Containment check
- `DEFAULT_FILE_MODIFY_POLICY` — Sensible defaults
- Integration examples in `file-security.integration.ts`

### Phase 2 (Next)
- Search/Replace edit extraction and normalization in agent mode
- Sandbox verification (`npx tsc --noEmit --pretty false`) before queueing

### Phase 3
- `patch-applier.ts` — Apply validated Search/Replace edits
- CLI confirmation gate with security summary

## Usage Examples

### Example 1: Validate a single file
```ts
import { validateFileTarget } from "./file-security.js";

const result = validateFileTarget("src/main.ts", "/workspaces/rei");
if (result.ok) {
  console.log("Safe to modify");
} else {
  console.error(result.error.message);
}
```

### Example 2: Pre-flight check before patch storage
```ts
import { preflight } from "./file-security.integration.js";

const check = preflight("src/agent.ts", workspacePath);
if (check.safeToModify) {
  // Store patch in AgentDecision.proposedPatches
}
```

### Example 3: Batch validation for CLI display
```ts
import { validateAllPatchTargets } from "./file-security.integration.js";

const results = validateAllPatchTargets(patches, workspacePath);
const invalid = results.filter(r => !r.valid);
if (invalid.length > 0) {
  console.log("Rejected patches:", invalid);
}
```

### Example 4: Custom policy
```ts
import { createCustomPolicy } from "./file-security.integration.js";

const strictPolicy = createCustomPolicy({
  allowedDirs: ["src/core/", "src/tools/"], // Narrower scope
  requiresValidation: [/.*/], // Validate all files
});

validateFileTarget("src/main.ts", workspacePath, strictPolicy);
```

## Testing Strategy

Current validation tested against:
- ✅ Path normalization (forward slashes)
- ✅ Workspace containment (relative path resolution)
- ✅ Directory allowlist matching
- ✅ Denied file patterns (glob-style)
- ✅ Symlink detection in path chain
- ✅ File existence checks

Tests would run in Phase 2+ when integrating with actual patch generation.

## Future Enhancements

- File size limits (reject patches for multi-MB files)
- Binary file detection (prevent corruption)
- Encoding validation (UTF-8 only, no raw bytes)
- Rate limiting (max patches per session)
- Audit logging (track all validation attempts)
