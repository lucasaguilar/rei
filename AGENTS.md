# AGENTS.md — working rules for this repo

REI is a local-first CLI coding agent (TypeScript, ESM). Its core bet: **trust nothing the model
says — verify every edit against ground truth.** Hold yourself to the same rule.

This file is read at runtime as project conventions, so it stays short and actionable. The
architecture — modes, the validation pipeline, prompt assembly, the token budget — lives in
`docs/rei-internals.md`.

## Verify before you finish

```bash
npx tsc --noEmit                           # must be clean — the SAME command CI runs
npx vitest run                             # must be green
```

Use that exact typecheck, not `-p tsconfig.build.json`: the build config EXCLUDES the tests, so it
compiles clean while CI fails on a test fixture that no longer matches a type you changed. That has
already happened — adding a required field to a result type passed locally and broke the build.

The typecheck is fully clean today. `src/chat/compactor.test.ts` used to carry one accepted type
error; it no longer does, so there is no expected failure to look past. Any error you see is yours.

## Rules

- **Never invent files, APIs, or behaviour.** If a file preview is truncated, read the file with
  `read_files` before editing it — do not reconstruct the missing part.
- **Act, don't narrate.** In agent mode, emit the tool call. A turn that describes an edit without
  applying it accomplished nothing.
- **One change per edit, and keep call sites in step.** If you change a name or a signature, update
  every caller in the same turn — a half-applied rename compiles nowhere.
- **Source files stay under 400 lines.** `src/meta/file-size.test.ts` enforces it. Split the module
  rather than adding to the allowlist.
- **ESM, always.** `package.json` is `"type": "module"`: use `import`/`export`, and give relative
  imports the `.js` extension (`./foo.js`), even from a `.ts` file.
- **English in code and in anything the user sees** — comments, status lines, error messages.
- **Write the regression test first, and prove it fails.** A test that passes against the unfixed
  code proves nothing. Run it before the fix, watch it fail, then fix.
- **Comments explain WHY, not what.** Prefer the reason a line exists — the bug it prevents, the
  constraint it satisfies — over restating the code.
- **No new `.md` files unless asked.** Documentation is a deliverable the user requests, not a
  side effect.

## Where things are

| Path | What |
|---|---|
| `src/agent-mode/` | the native tool-calling loop and its handlers |
| `src/chat/commands/` | one handler per slash command, registered in `registry.ts` |
| `src/config/model-runtime.ts` | single source of truth for context window, tokens, thinking |
| `src/workspace/project-type.ts` | project detection and each type's real verify command |
| `prompts/` | the system prompt, as markdown — modes, formats, skills, roles |
| `docs/rei-internals.md` | how it all fits together |

Per-project conventions come from the workspace's `.rei/rules.md`, which overrides anything generic
here.
