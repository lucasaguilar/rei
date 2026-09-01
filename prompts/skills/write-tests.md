---
name: write-tests
description: Write unit tests for a file, or one test per acceptance criterion when a spec exists, following the repo's existing test style and runner
modes: agent
---

# Skill: Write unit tests matching the repo

Use when asked to add or improve tests for a file/function, or to prove that implemented work
satisfies a spec.

## Step 0 — is there a spec?

Check `.rei/specs/` (`run_command` `ls .rei/specs/ 2>/dev/null`) and the conversation for a spec with
**Acceptance criteria**. If there is one, it changes what you test:

- **With a spec** — the criteria ARE the test list. Write one test per numbered criterion and name it
  so the mapping survives without a document: `it("criterion 3: the list shows each server's state")`.
  A criterion with a passing test is the only evidence that it is met; a verdict in prose is not.
- **Without a spec** — test the code's real branches, as below.

Testing what the code happens to do proves it did not change. Testing what the spec asked for proves
it does what was requested. Those are different questions, and a spec means the second one is the
one being asked.

## Steps

1. **Find the test convention first.** `run_command` `find . -name "*.test.ts" -o -name "*.spec.ts" | head`
   and `read_files` 1-2 existing test files NEAR the target. Match their runner, imports, and structure
   — do NOT invent a framework (Vitest vs Jasmine vs Jest differ).
2. **Read the file under test** with `read_files`. Identify the public functions/exports and their
   branches (happy path, edge cases, error paths).
3. **Write the test file** with `create_file` (e.g. `<name>.test.ts` next to the source, or wherever
   the repo puts them). Cover: the main success case, at least one edge case, and error handling.
   With a spec, cover every criterion first, then add edge cases the criteria don't name.
   Import only what exists — never assume helpers.
4. **Run the tests** with `run_command` using the project's command (check `package.json` scripts —
   often `npx vitest run <file>` or `npm test`).
5. If tests fail, read the failure, fix the test (or surface a real bug in the code), and re-run until
   green. Report honestly if a failure reveals a code bug rather than a test mistake.

## Criteria you cannot test

Some acceptance criteria are not unit-testable — visual layout, "feels fast", anything needing a real
browser or a live third-party service. Do NOT fake them with a test that asserts nothing, and do NOT
quietly skip them. Write the tests you can, then state plainly which criteria have no test and why,
so the gap is visible instead of assumed:

```
Criteria 1, 2, 4 — covered by tests in <file>
Criterion 3 ("the panel renders above the fold") — no test: needs a real viewport, verify by hand
```

A run that honestly reports 4 of 5 criteria covered is worth more than one claiming 5 with a hollow
test for the fifth.
