# How REI runs a command

`run_command` does not hand the string to a shell. Commands are spawned with `shell: false`, and
every command name is checked against an allow-list. That single decision is what the sandbox rests
on — and it is also why REI has to re-implement, deliberately and partially, the pieces of shell
syntax that matter.

Everything below lives in `src/tools/command-executor.ts`.

---

## The pipeline

```
run_command("…")
  │
  ├─ 1. Reject unsupported shell features        unsupportedShellFeature()
  │        checked ONCE, over the whole line, before any splitting
  │
  ├─ 2. Split off a heredoc                      extractHeredoc()
  │        the body is DATA — it is never parsed as commands
  │
  ├─ 3. Split into statements                    splitOnSemicolon()
  │        `cd` carries across `;`
  │
  └─ for each statement:                         executeStatement()
       ├─ 4. Split on `&&` / `||`                splitOnLogicalOps()
       │        quote-aware: `git commit -m "a && b"` is NOT split
       ├─ 5. Split on `|`                        splitOnPipe()
       ├─ 6. Tokenise                            parseCommandLine()
       │        quotes, `$VAR` expansion, line continuations, whitespace
       ├─ 7. Extract redirects                   extractRedirects()   `>` `>>` `2>`
       └─ 8. Validate and spawn                  prepareCommand()
                denied keywords → allow-list → per-command extra rules
```

Order is load-bearing at two points, and both were bugs first:

- **The feature check runs before splitting.** Per segment, `for f in …; do …; done` produced three
  errors — `for` explained properly, then `do` and `done` each blaming the allow-list — which buried
  the explanation in noise.
- **The heredoc is resolved before anything else.** Its body is data. When it was tokenised, a
  `python3 - <<EOF` script got empty stdin and exited 0 having done nothing — a silent no-op the
  model reads as success. Worse, a `;` inside the body split it, yielding
  `Command 'break' is not in the allow-list`.

---

## What the tokeniser handles

`parseCommandLine` is a small shell-compatible tokeniser. Each rule exists because its absence
produced a failure that did not look like a parsing problem:

| Input | Behaviour | Why |
|---|---|---|
| `'…'` / `"…"` | Quotes group, and are removed | `git commit -m "a b"` is one argument |
| `$VAR`, `${VAR}` | Expanded, unless single-quoted | `shell: false` means nobody else expands it; `curl -H "Bearer $TOKEN"` sent the literal string and returned an unexplained 401 |
| `$UNDEFINED` | Left **literal**, not emptied | A deliberate deviation: the failure then names the missing variable instead of silently sending `Bearer ` |
| `\` + newline | Line continuation, removed | A model formats a long chain the way a shell accepts it; the backslash and newline stayed glued to the next word and the command name became `\<newline>git` |
| newline, tab | Separate arguments when unquoted | A multi-line command otherwise carried the newline into the token |

Single quotes keep a continuation literal, as a shell does — `awk '{print $1}'` and `sed 's/$x/y/'`
are allow-listed and would break under naive expansion.

---

## What REI refuses, and why it is not an oversight

`unsupportedShellFeature()` rejects constructs the sandbox cannot run, with a message naming the
alternative. These are **not** missing entries in a list:

| Construct | Instead |
|---|---|
| `for`, `while`, `until`, `if`, `case`, `select`, `function` | One command per call, chained with `&&` or `\|`; or `find … -exec`; or put the loop in a script via a heredoc |
| `$(…)`, backticks | Run the inner command, then use its output |
| Globs the command does not expand itself | `find`, or the tool's own pattern flag |

They failed in two different ways before, and the quieter one was worse: control flow hit
"Command 'for' is not in the allow-list", which reads as a missing permission rather than a missing
feature — the obvious next move is to add `for` to the list, which cannot work.

Substitution was the dangerous one: `$(…)` used to be passed through as a **literal string**, so the
command ran with a nonsense argument and often still exited 0.

---

## The security layers

Three, in order. Each catches something the next cannot:

1. **Denied keywords**, scanned over the raw segment — and again after `$VAR` expansion, because a
   variable holding `rm -rf` would otherwise slip past by indirection.
2. **The allow-list**, on the command name only. Configurable; `getAllowedCommands()`.
3. **Per-command rules.** `rm -r` is refused outright, whatever the allow-list says.

Beyond those, two confirmation gates ask the user before running something permitted but
destructive (`REI_CONFIRM_DESTRUCTIVE`, `REI_CONFIRM_GIT_MUTANT`). They need an `elicit` callback:
without one the gate cannot ask, and so does not fire — which is why `elicit` is threaded all the
way through to `/runplan`'s sub-agents.

---

## Output

`limitCommandOutput` caps what reaches the model, keeping the head AND the tail — the interesting
part of a long build log is at both ends, and a middle-out cut says how much was dropped.

What reaches the USER is separate, and quiet by default: a successful command shows its exit code
and a line count; a FAILED one shows its last lines, because that is the case that has to be read.
`--verbose` restores the full output. See `src/config/output-verbosity.ts`.
