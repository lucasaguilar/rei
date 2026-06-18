---
name: write-tests
description: Write unit tests for a file following the repo's existing test style and runner
modes: agent
---

# Skill: Write unit tests matching the repo

Use when asked to add or improve tests for a file/function.

Steps:

1. **Find the test convention first.** `run_command` `find . -name "*.test.ts" -o -name "*.spec.ts" | head`
   and `read_files` 1-2 existing test files NEAR the target. Match their runner, imports, and structure
   — do NOT invent a framework (Vitest vs Jasmine vs Jest differ).
2. **Read the file under test** with `read_files`. Identify the public functions/exports and their
   branches (happy path, edge cases, error paths).
3. **Write the test file** with `create_file` (e.g. `<name>.test.ts` next to the source, or wherever
   the repo puts them). Cover: the main success case, at least one edge case, and error handling.
   Import only what exists — never assume helpers.
4. **Run the tests** with `run_command` using the project's command (check `package.json` scripts —
   often `npx vitest run <file>` or `npm test`). 
5. If tests fail, read the failure, fix the test (or surface a real bug in the code), and re-run until
   green. Report honestly if a failure reveals a code bug rather than a test mistake.
