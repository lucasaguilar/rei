# Shell escape — `!cmd` from the REI prompt

Status: **phases 1–2 shipped** (run a command; hand its output to the model with `/attach`).
Phases 3–4 are designed below, not built.

## Why

A developer inside a REI session asks the agent for things they could do in a second: `git status`,
`ls src`, `npm test`, "commit this". Each of those is an inference turn — on a local model, tens of
seconds plus the tokens — and its tool traffic stays in the model's context for the rest of the
turn or session.

The shell escape lets the developer run the command themselves, from the same prompt, without the
model: milliseconds instead of a turn, and the context left exactly as it was. Later phases let
them decide, command by command, whether the model gets to see the output — the developer curating
what enters the context, which is the same concern behind the history demotion and the spill
budget.

## Phase 1 — `!cmd` (shipped)

| You type | What happens |
|---|---|
| `!git status` | Runs in your shell, in the workspace. Output goes to the transcript, then a footer: `↳ exit 0 · 45ms · not sent to the model` |
| `!` alone | Runs nothing; prints how to use it |
| `!cmd` while a turn is running | Refused with a notice. It is **not** queued: queued text is handed to the model, the one place a shell command must never go |
| `Ctrl+C` while the command runs | Stops the command (SIGINT to its whole process group, SIGKILL after 1.5 s). REI keeps running |

Only a **leading** `!` counts: `why does !x fail?` is a question for the model.

### How it runs

`src/cli/shell/run-shell-command.ts`:

- **Your shell**: `$SHELL -c "<cmd>"` (falls back to `/bin/sh`), so pipes, globs, `&&`, `$VAR` and
  your shell's syntax all work.
- **In the workspace**: `cwd` is the session's workspace. `cd` inside one command works
  (`!cd src && ls`); it does not persist to the next one (phase 4).
- **No TTY, so nothing waits on one**: stdin is closed (`cat` with no file ends instead of hanging),
  `PAGER=cat` and `GIT_PAGER=cat` print straight through, and `GIT_EDITOR=false` makes
  `git commit` without `-m` fail with git's own message instead of opening vi where nobody can see
  it. Interactive programs need phase 3.
- **Colour kept**: `FORCE_COLOR=1` / `CLICOLOR_FORCE=1`, because the output is for human eyes.
- **Own process group** (`detached`), so `Ctrl+C` reaches every stage of a pipeline — killing only
  the shell would leave `sleep 30 | cat` running after REI said it stopped.

Wiring: `parseShellEscape` / `handleShellEscape` in `src/cli/shell/shell-escape.ts`, called from
`handleInputCommand` (`src/cli/helpers/input-command.helpers.ts`) before slash-command parsing;
the busy guard in `src/cli/ui/input-handler.ts`; `state.shellAbort` checked first by `Ctrl+C` in
`src/cli/ui/keyboard-handler.ts`.

### Security: the user's command, so CLI only

This is not the model's `run_command`. It does **not** go through the allow-list, the path checks
or the destructive-command gate — those constrain the *model*; here the developer is typing into
their own shell, with exactly the power of their own terminal.

That is why it must never be reachable from `src/server.ts`. Over HTTP (and so over WhatsApp),
`!rm …` would be remote command execution for anyone who can POST. The server treats a leading `!`
as ordinary prompt text, and `shell-escape.test.ts` fails if anything under `src/server*` or
`src/chat/` imports `src/cli/shell/`.

## Phase 2 — `/attach`: hand the output to the model (shipped)

By default a `!cmd` stays between you and your terminal. When one matters — the failing test, the
diff you want reviewed — you hand it over:

```
🧠 agent » !npm test
$ npm test
… 1 failing …
↳ exit 1 · 2.3s · not sent to the model · /attach to hand it over
🧠 agent » /attach
🧾 npm test (exit 1 · 3.1k) goes with your next message · /detach to drop it

🧾 npm test (exit 1 · 3.1k)                ← indicator above the prompt while attached
🧠 agent » why does it fail?
```

| Command | What it does |
|---|---|
| `/attach` | Marks the **last** `!cmd` to go with your next message. `Nothing to attach` if there is none |
| `/detach` | Un-marks it |

Rules:

- **Only the last command.** A new `!cmd` replaces the receipt; if the old one was attached, REI says
  it is no longer attached, so nobody sends a message believing the model sees stale output.
- **One message.** The next typed prompt carries it and the receipt is cleared — re-sent on every
  later message it would be context paid for twice.
- **The transcript shows what you typed**, plus one line: `🧾 sent with this message: $ npm test …`.

### What the model receives

```
[Verified — the user ran this in their own shell; REI captured the command, exit code and output. Treat it as fact; do not re-run it to confirm.]
$ npm test   (exit 1, 2.3s)
<output>

why does it fail?
```

It is framed as **evidence, not as something the user says**: REI captured the command, exit code
and output itself, so unlike pasted text it cannot be misquoted. A model that doubted it would
re-run `npm test` "to confirm" — spending exactly the turn this feature exists to save.

On the way out it is treated like tool output (`src/cli/shell/shell-receipt.ts`):

- **ANSI stripped** — the colour was for human eyes.
- **Secrets masked** (`maskSecrets`) — an attached `!env` would otherwise ship API keys to a cloud
  provider.
- **Same inline budget** (`retainAndMaybeSpill`) — a 20k-line log is spilled to disk with a receipt
  and a preview instead of flooding the window. The capture itself is capped at 1M chars.

`/attach` and `/detach` are handled in the CLI (`handleReceiptCommand`), **not** in the
`src/chat/commands/` registry, which the HTTP server shares.

## Phase 3 — interactive subshell (designed)

- `!` + Enter on an empty command opens your real `$SHELL` with `stdio: "inherit"`: vim,
  `git add -p`, `htop`, a merge's commit-message editor. `exit` returns to REI.
- Mechanics: leave raw mode and stop the keypress listener, spawn, wait, restore raw mode, redraw.
- This is what makes `git merge` / `git rebase -i` usable without leaving the session.

## Phase 4 — comfort (designed)

- **Mid-turn**: run a read-only `!git diff` while the agent works. Needs care: a `!git checkout`
  under a running agent changes the files it is editing.
- **Shell mode prompt**: typing `!` on an empty line switches the prompt to `$` (Backspace on
  empty leaves it), with its own history (`.rei/shell_history`) on the up arrow.
- **Persistent `cd`** across commands, shown in the prompt.
