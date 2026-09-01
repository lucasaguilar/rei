---
name: verify-against-spec
description: After implementing, judge the work against the spec's acceptance criteria one by one — MET / NOT MET / UNVERIFIED, each with evidence — instead of assuming a green build means the request was satisfied
modes: agent
---

# Skill: Verify the implementation against the spec

Use AFTER the work is implemented, as the closing step of a spec-driven task.

A green build answers "did I break anything?". It does not answer "did I build what was asked?".
The project's verify command can pass while a criterion was silently dropped, half-built, or
implemented as something adjacent. This skill closes that gap by walking the criteria one at a time.

The `auditor` role reviews the plan BEFORE implementation; this reviews the result AFTER it. They are
different jobs — do not substitute one for the other.

## Ground it first

1. Load the spec: `.rei/specs/<name>.md` (`run_command` `ls .rei/specs/`), or the spec in the
   conversation. If there is no spec with acceptance criteria, say so and stop — there is nothing to
   verify against, and inventing criteria after the fact defeats the purpose.
2. See what actually changed: `run_command` `git diff --stat` then `git diff` (or `git_changes`).
3. Run the project's verify command and the test suite. Record the real result.

Judge the CODE, not your memory of writing it. Re-read the files with `read_files`. If you cannot
point at a file and line, you have not verified anything.

## Emit exactly this

```
# Spec verification: <spec name>

## Criterion 1 — "<the criterion, verbatim>"
**MET** · <file>:<line> — <what there satisfies it, in one line>
Evidence: <test name that covers it, or the command whose output proves it>

## Criterion 2 — "<verbatim>"
**NOT MET** · <what is missing or wrong, and where it should have gone>

## Criterion 3 — "<verbatim>"
**UNVERIFIED** · <why it cannot be checked here — needs a browser, a real service, a human eye>

## Summary
- Met: N of M (K backed by a passing test)
- Not met: <list, or "none">
- Unverified: <list, or "none">
- Out-of-scope work found: <changes the spec did not ask for, or "none">
```

## Rules

- **Three verdicts, not two.** UNVERIFIED is not a soft NOT MET — it means the check cannot be made
  from here. Using MET for something you did not check is the failure this skill exists to prevent.
- **Quote each criterion verbatim.** Paraphrasing lets a criterion drift into whatever the code does.
- **MET needs evidence**: a file and line, plus a test or a command output. "It looks implemented" is
  not evidence. A criterion whose only support is your own reasoning is UNVERIFIED, not MET.
- **A passing test is the strongest evidence.** Say which criteria have one and which do not — that
  distinction is the useful part of the report.
- **Report out-of-scope work.** The spec's "Out of scope" list is a contract too. If the diff touches
  something it excluded, that is a finding, even when the code is good.
- **Do not fix things here.** Report. Fixing mid-verification turns the report into a moving target;
  the user decides what to do with the findings.
- **Do not soften.** NOT MET on your own implementation is the expected, useful outcome — it is why
  the step is run. A report that always says everything passed is worth nothing.
