# LSP Diagnostics — Design

Status: **proposed** (not yet implemented). Author note: design grounded in REI's
existing validation architecture (`src/tools/compile-check-core.ts`,
`src/agent-mode/generator-tools.ts`).

## Goal

Give the agent a **fast, incremental, per-file code-correctness feedback loop** after
each edit, instead of only the current cold full-project `tsc` compile. This is the
loop that makes an agent reliable:

```
edit → ask diagnostics → errors? → fix → repeat → done
```

OpenCode/Crush ship this via LSP; REI currently relies on a full `tsc` compile (slow,
whole-project, TS-only) or the model self-verifying via `run_command`.

## Why it fits REI cleanly (reuse, don't reinvent)

REI already has the right seams:

- **`CompileAdapter` interface** + adapter registry (TS, C#) — `compile-check-core.ts`,
  `compile-check-factory.ts`. LSP slots in as another diagnostics source.
- **`GenericDiagnostic { filePath, line, column, message, code }`** — this is *exactly*
  the shape an LSP `Diagnostic` maps to. Downstream (`formatResult`,
  `resolveReferencedFiles`, the `verifyRetries` self-correct loop) stays unchanged.
- **`virtualFiles: Map<path, editedContent>`** — the in-memory edited text. LSP's
  `textDocument/didChange` takes exactly this, so we get diagnostics on **unsaved edits
  without copying the workspace** (today's `createSandboxWorkspace` copies the whole tree).
- **`detectProjectType()`** (`src/workspace/project-type.ts`) — reused to pick the server.

### Cold tsc vs warm LSP

```
tsc today:  edit → copy workspace to sandbox → spawn tsc (cold) → compile ALL → parse stdout
LSP:        edit → didChange(in-memory text) → server already WARM → diagnostics in ms
```

## What you must install (and what REI can bundle)

This is the key decision. Split by language:

| Language | Server | Bundle in REI? | User installs? |
|---|---|---|---|
| **TypeScript / JS** | `typescript-language-server` + `typescript` | ✅ **Yes** — pure npm, add to REI's `package.json` | **Nothing** |
| **Python** | `pyright` (npm) | ✅ Yes — pure npm | Nothing |
| **Rust** | `rust-analyzer` | ❌ native per-platform binary | `rustup component add rust-analyzer` |
| **Go** | `gopls` | ❌ native binary | `go install golang.org/x/tools/gopls@latest` |

**LSP client libs** (`vscode-jsonrpc`, `vscode-languageserver-protocol`): always bundled —
they are REI's own npm deps.

### Bundling strategy for TS (zero-install)

Add to REI's `package.json` `dependencies`:
`typescript-language-server`, `typescript`, `vscode-jsonrpc`, `vscode-languageserver-protocol`.

Then REI ships the TS server inside `~/.rei/node_modules` and launches its binary from
`node_modules/.bin/typescript-language-server` (resolve via `require.resolve` / the
install root). **The user installs nothing for TS/JS.**

Important nuance: the most accurate type-checking uses the **project's own** TypeScript
version + `tsconfig.json`. `typescript-language-server` auto-discovers the workspace's
`node_modules/typescript`; REI's bundled copy is only the **fallback** when the project
has none. So: prefer workspace TS, fall back to bundled.

Native servers (rust-analyzer, gopls) can't be npm-bundled per platform → they stay
user-installed, with detection + graceful skip (never fatal).

## Components

| # | Component | File | Build / Reuse / External |
|---|---|---|---|
| 1 | LSP client (JSON-RPC stdio, framing, handshake, notify/request) | `src/lsp/lsp-client.ts` | Reuse `vscode-jsonrpc` + `vscode-languageserver-protocol` |
| 2 | Server registry (project-type → server command) | `src/lsp/server-registry.ts` | Build (small); uses `detectProjectType` |
| 3 | LSP manager / warm pool (1 server per workspace+lang, lifecycle, restart, shutdown) | `src/lsp/lsp-manager.ts` | Build — the core of the feature |
| 4 | Diagnostics provider (`virtualFiles` → `GenericDiagnostic[]`, debounce+timeout) | `src/lsp/lsp-diagnostics-provider.ts` | Build |
| 5 | LSP→Generic mapping | `src/lsp/lsp-to-generic.ts` | Build (trivial) |
| 6 | URI helpers (`path ↔ file://`, Windows) | `src/lsp/uri.ts` | Build (trivial) |
| 7 | Loop integration (post-edit hook) | edit `src/agent-mode/generator-tools.ts` (`verifyRetries` ~L272, `persistToDisk` ~L361) | Edit existing |
| 8 | Factory branch (LSP vs tsc) | edit `src/tools/compile-check-factory.ts` | Edit existing |
| 9 | Navigation tools (`goto_definition`/`find_references`/`hover`) — **phase 3** | `src/lsp/tools/navigation-tools.ts` | Build (optional) |
| — | TS server binaries | `typescript-language-server` + `typescript` | **Bundled npm dep** (zero-install) |

## Data flow (phase 1, TS)

```
edit_file applied → virtualFiles{ "src/x.ts": newContent }
  → LspManager.ensureServer("typescript", workspace)   ← WARM, reused (no re-spawn)
  → for each changed file: didOpen/didChange(version++, text = virtualFiles[path])
  → server pushes textDocument/publishDiagnostics  (debounce ~300ms / timeout 3s)
  → LSP Diagnostic[]  →map→  GenericDiagnostic[]   (same type used today)
  → formatResult + resolveReferencedFiles → feed back to model (existing verifyRetries)

  ↓ final gate, once per turn
  full tsc = authoritative whole-project check + fallback when no server
```

## Config / flags

```bash
REI_LSP_DIAGNOSTICS=1            # master switch (default 0 initially)
REI_LSP_DIAGNOSTICS_AGENT=1      # per-mode, like REI_ON_DEMAND_FILE_CONTEXT
REI_LSP_SERVER_TS="typescript-language-server --stdio"   # command override
REI_LSP_TIMEOUT_MS=3000          # how long to wait for publishDiagnostics
```

Graceful degradation: no server binary → one-line log + fall back to current `tsc`.
Never breaks the turn.

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| LSP diagnostics are **per-open-document**: an error in A caused by editing B won't show unless A is open | Open all files in the edit batch + those from `resolveReferencedFiles`; keep **full tsc as authoritative final gate** |
| `publishDiagnostics` is async push | debounce + timeout; wait for all N changed files or expire |
| Server not installed (native langs) | detection + fallback to tsc; non-fatal |
| Process lifecycle (zombies, crash) | manager shuts down on REI exit + restarts on crash |
| Windows paths / `file://` URIs | centralized `uri.ts` |
| Monorepo / tsconfig resolution | server resolves its own tsconfig (usually fine); document |

## Phasing

1. **Phase 1 (MVP, ~80% of value):** client + manager + TS provider, wired as the fast
   inner-loop check; tsc as final gate + fallback. Flag `REI_LSP_DIAGNOSTICS`. TS server
   bundled → zero-install.
2. **Phase 2:** more languages via `server-registry` (pyright bundled; rust-analyzer/gopls
   user-installed).
3. **Phase 3:** navigation tools (`goto_definition` / `find_references` / `hover`) as agent
   tools — better grounding than RAG.

## Effort

Medium. The bulk is `lsp-manager` (warm pool + lifecycle) and the diagnostics debounce.
Everything else leans on existing pieces: `GenericDiagnostic`, `virtualFiles`, the verify
loop, `detectProjectType`.
