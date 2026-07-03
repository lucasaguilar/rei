---
name: less-is-more
description: Apply YAGNI-first thinking — prefer deleting, reusing, or using native features over writing new code; pause before creating anything non-trivial
modes: agent, planning
---

# Skill: Less Is More (YAGNI-first)

The best code is the code you never wrote. Before implementing any task, run the four filters below
in order. The goal is not to do less work — it's to **do the right amount of work**.

## The 4 filters (in order)

### 1. Does it already exist?
- Search the codebase (`run_command` with `grep`/`rg`) for similar functions, types, utilities, or
  components BEFORE writing new ones.
- If a utility exists that does 80% of what you need, extend it — don't write a parallel one.
- Check `src/utils/`, `src/lib/`, shared modules, and the project's existing patterns before
  creating something new.
- If the project already has a convention (naming, folder structure, error handling style), follow it
  instead of introducing a new one.

### 2. Can I use the language or platform natively?
- TypeScript has built-in features for most common patterns (`Record<K,V>`, mapped types, template
  literal types, `satisfies`). Use them instead of writing utility functions.
- Node.js has built-in filesystem APIs (`fs`), HTTP servers, etc. Don't add a dependency unless the
  native option is genuinely insufficient.
- Angular signals (`signal()`, `computed()`, `input()`) replace many custom reactive utilities.
  Check if a signal can do what an Observable wrapper would do.
- The project's existing tool definitions (`read_files`, `edit_file`, `run_command`) are your
  execution surface — use them directly instead of wrapping them in abstractions.

### 3. Can I delete instead of adding?
- Before writing new code, ask: "Is there existing code that becomes unnecessary with this change?"
  If yes, **delete it first**, then write the replacement.
- Dead code is more expensive than no code — it accumulates technical debt silently. After changes,
  check for unused exports, orphaned imports, and dead code paths.
- A file that does one thing and does it well is better than a file that does three things. If a
  file is doing too much, consider splitting — but only if the split is justified by actual usage,
  not theoretical purity.

### 4. Is this actually needed?
- If the task can be solved with zero file changes, say so explicitly and stop.
- If the user asked for X but Y would solve it faster with less code, propose Y first — get
  confirmation before proceeding.
- "Display config values" = display them. Do NOT add editing, persistence, caching, or a settings
  UI unless explicitly requested.
- When in doubt between two approaches, pick the one that introduces fewer new files and fewer new
  concepts.

## Hard pause rules

STOP and ask the user BEFORE:
- Creating a new file that doesn't replace an existing one
- Adding a dependency (`npm install`) when native code or an existing dependency suffices
- Refactoring something that isn't broken ("while I'm here..." changes)
- Implementing beyond what the acceptance criteria or spec demands

## Anti-patterns to reject

| Anti-pattern | What it looks like | What to do instead |
|---|---|---|
| Parallel utility | "I'll create `src/utils/formatDate.ts`" when `date-fns` or native `Intl.DateTimeFormat` exists | Use the existing tool, extend minimally |
| Feature creep | Adding validation/error handling for a path that can't fail per the spec | Skip it; mention as an open question if relevant |
| "While I'm here" refactor | Changing unrelated code "to be consistent" with the change | Don't. One file, one logical change |
| Dependency inflation | Adding a 50 KB package for a 3-line function | Check native alternatives first; justify any new dep in the plan |
| Abstraction for one caller | Extracting an interface/type that only one consumer uses | Keep it inline; extract only when a second consumer appears |

## Integration with other skills

- **Before planning**: Run these four filters before invoking `write-spec`. The spec's "Out of scope"
  section should reflect what you eliminated here.
- **During implementation**: After each stage of a plan, ask "did I create something that could have
  been deleted or reused?" If yes, reconsider before moving on.
- **After completion**: Suggest cleanup — unused imports, dead code paths, over-engineered abstractions
  for one-time use cases.

## Output format

When you invoke `use_skill less-is-more`, emit a brief analysis first:

```
Less-is-more check:
- Existing alternatives found: <list or "none">
- Native features applicable: <list or "none">
- Code to delete: <list or "none">
- New files proposed: <count> (justify each)
- Decision: proceed / propose alternative / stop here
```

Then follow with the implementation, respecting whatever you eliminated.
