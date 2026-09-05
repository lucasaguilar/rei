# Mini-spec: multi-session (parallel agents on one repo, Cursor-style)

Status: **SPEC (defined, not implemented).**

## Goal

Run **N REI instances on the same repo, each with its own conversation/context** (like N chat tabs
in Cursor, or N tmux sessions) — without them corrupting each other's history. Retomable: close a
terminal, reopen, continue where you left off.

## The problem today

- Session path is hardcoded: `<workspace>/.rei/sessions/current.json` — **one global active session**.
- **Two collision points** (both verified):
  1. **Restore:** every instance auto-loads `current.json` at start (`run-chat.ts` → `loadCurrentSession`).
  2. **Persist:** `saveSession` overwrites the WHOLE `current.json` **every turn** (not append/merge).
- Result with two terminals on the default session: **last-write-wins** → lost updates, missing turns on
  reopen, and (rarely, `writeFileSync` is not atomic) a **corrupt JSON**. Fails **silently** — each
  terminal looks fine in memory. See the day-to-day breakdown in the design notes.
- `rag-index.json` (shared) and `agent-flow.jsonl` (append) do NOT collide — only the session does.

## Design reference (verified)

Both frontier references use the SAME model — **new by default, resume is explicit** — and NEITHER
forces a selector at launch:

| | Default | Continue last | Pick from history | Storage |
|---|---|---|---|---|
| **Claude Code** | `claude` → NEW | `claude -c` / `--continue` | `claude -r` / `--resume` (selector) | per working dir |
| **Pi** | new | — | `pi -r` / `--resume` / `/resume` (TUI selector) | `~/.pi/agent/sessions/`, per cwd |

Takeaway: default = fresh (zero-friction launch); resume = opt-in flag; sessions organized per
directory; named sessions are easier to find. A mandatory launch selector adds friction on every
open and neither tool does it.

## The model for REI

Shift from *"one global active session"* to *"N named sessions per workspace, one active per instance"*.

### Session file
- `<workspace>/.rei/sessions/<name-or-auto-id>.json` (was: the single `current.json`).
- No flag → a fresh `sessions/<auto-id>.json` (never the shared `current.json`), so plain `rei` in two
  terminals can't collide by default.
- Reuses the existing naming/list/load machinery (`archiveCurrentSession(customName)`,
  `loadSessionById`, `listSessions`, `/session list`).

### Launch surface (CLI flags — like `--workspace`, not slash commands)
```
rei                       # NEW session (default, fast launch) + prints the last 3 as a hint
rei -c / --continue       # continue the most recent session in this workspace
rei -r / --resume         # open a selector of past sessions (opt-in — Claude/Pi's -r)
rei -s / --session <name> # open/create a named session (the parallel-agents case)
```
- `rei -s frontend` + `rei -s backend` in two terminals → two isolated sessions, no collision, both
  retomable by name.
- The last-3 hint at launch is a discoverability nudge (small improvement over Claude/Pi), NOT a
  blocking menu.

### Lock (the safety piece — none exists today)
When an instance opens `sessions/<name>.json`, write `sessions/<name>.lock` with `{ pid, startedAt }`.
- Second instance opening the SAME name → detect the lock → **warn: "session '<name>' is already open
  in PID X"** and offer: pick another name / open read-only / force (steal the lock).
- Release the lock on clean exit. A **stale lock** (PID not alive) is auto-cleaned, so a crash doesn't
  wedge a session.
- This is what makes multi-instance safe even for the accidental case (two plain `rei` in one repo).

## Default behavior (decided): `rei` = ALWAYS a NEW session

`rei` with no flag starts a **fresh session** (like Claude Code / Pi) — it does NOT auto-restore.
This is a **deliberate change** from today's behavior (REI currently auto-loads `current.json`). The
new session is saved to its own `sessions/<auto-id>.json` (id = timestamp), so it never overwrites a
previous one. Recovering the last session is easy and explicit: `rei -c`. At launch REI prints a hint
— *"New session — `rei -c` to continue the last one (was: <title>)"* — so nothing feels lost.

Why: it's consistent with Claude Code/Pi, and it's the natural fit for parallel agents (each `rei` is
its own isolated conversation, no collision by default). The old "resume automatically" habit is one
keystroke away (`-c`).

## Config / flags summary
| Flag / var | Effect | Default |
|---|---|---|
| (none) | **NEW session** (`sessions/<auto-id>.json`), never overwrites; prints last-3 hint | ✓ |
| `--continue` / `-c` | resume the most recent session (highest `updatedAt`) | — |
| `--resume` / `-r` | open the session selector (pick from a list) | — |
| `--session <name>` / `-s` | open/create a NAMED session `sessions/<name>.json` (parallel agents) | — |
| `REI_SESSION_NAME` | env equivalent of `--session` (for scripts/launchers) | — |

## Implementation phases

1. **Named session file + `--session`/`REI_SESSION_NAME`.** Parameterize `session-store.ts` so the
   active file name is resolved from the instance (default `current.json`). Thread the name from
   `run-cli.ts` flag parsing (pattern already there for `--workspace`) into `run-chat.ts`
   (`loadCurrentSession`/`saveSession`). — *delivers parallel isolated agents.*
2. **Lock.** `acquireSessionLock(workspace, name)` on open (write `<name>.lock` with pid), release on
   exit, stale-detection via `process.kill(pid, 0)`. On conflict, prompt (reuse the elicitation
   primitive). — *the safety piece.*
3. **`-c` / `-r` + last-3 hint.** `-c` = newest by `updatedAt`; `-r` = selector (reuse `listSessions`
   + the CLI selection UI); print last 3 at launch. — *the resume UX.*
4. **Later:** append-only JSONL per session (Pi-style) for corruption-resistance instead of full
   overwrite; per-session `/tree` navigation. Bigger; not needed for the goal.

Stop after Phase 1+2 and REI already has safe parallel sessions.

## Connections
`[[rei-context-drift]]` (the existing `/tree` is prune, distinct from Pi's session-tree nav) ·
`[[rei-merge-loses-uncommitted-work]]` (same family of silent-overwrite hazards).
