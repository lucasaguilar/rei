# Security

REI runs shell commands and edits files on the machine it is installed on. That is the point of the
tool, and it is also its threat model. This page says what it guards, what it does not, and how to
report something.

## Reporting a vulnerability

**Do not open a public issue.** Email the maintainer (see `package.json`) with what you found, how to
reproduce it, and what it lets an attacker do. You will get an acknowledgement; a fix and a public
note follow once there is something to update to.

## What REI guards

**Commands run without a shell.** Every command is spawned with `shell: false`, so there is no
interpolation, no globbing and no chaining beyond what REI parses itself. `$(…)`, backticks and
`&&`-smuggling do not reach a shell interpreter.

**An allow-list of binaries.** Each segment of a command line is checked against a static list
(≈60 entries) before anything is spawned. Anything else is rejected. `REI_ALLOWED_COMMANDS` extends
it — deliberately, by you.

**A workspace boundary.** File operations resolve inside the workspace. `REI_ALLOWED_DIRS` opens
specific paths outside it, again deliberately.

**Confirmation gates.** Destructive commands (`rm`, `git reset --hard`, `git clean`,
`git checkout --`) and state-mutating git operations (`commit`, `push`, `merge`, `rebase`) ask
before running, in an interactive session. `REI_CONFIRM_DESTRUCTIVE=false` and
`REI_CONFIRM_GIT_MUTANT=false` turn that off; leaving them on is the safe default.

## What REI does NOT guard

**The model decides what to run.** The allow-list bounds *which binaries*, not *what they do*. An
allow-listed command with the wrong arguments can still delete your work. Keep your project under
version control, and commit before letting an agent loose on it.

**Prompt injection is real.** A file REI reads, a web page it fetches, or a tool result it receives
is untrusted text that reaches the model. Content crafted to look like an instruction can steer the
agent. Nothing in REI detects this. Treat an agent session over untrusted content the way you would
treat running a script from that source.

**`rei-server` is the agent behind an HTTP endpoint.** Anything that can POST to it can edit files
and run commands in the workspace. It binds `127.0.0.1` for that reason, and refuses to start on any
other interface unless `REI_SERVER_TOKEN` is set. With no token the CORS header stays `*` (IDE
clients need it) — which is safe only because the port is loopback-only. If you expose it, set the
token, and set `REI_SERVER_ORIGIN` rather than leaving the wildcard.

**MCP servers run with your permissions.** A server you connect is a process on your machine with
your user's rights. REI does not sandbox it. Connect the ones you trust, and read what a server does
before enabling it. They are `"enabled": false` in config for that reason.

**Secrets in the environment reach the model's context if a tool prints them.** REI does not scan
tool output for credentials. `env`, `cat .env` and similar will put whatever they print into the
conversation — and, with a cloud provider, into a request that leaves your machine.

**Local ≠ private if you point it at a remote endpoint.** A "local" provider configured with a LAN or
internet URL sends your code there. Check `<PROVIDER>_BASE_URL` before assuming nothing leaves.

## Data that stays on disk

Sessions, logs and spilled tool output live under `.rei/` in the project and are **not** encrypted.
`.rei/logs/agent-flow.jsonl` records prompts and tool results and grows without bound — it is a full
transcript of what the agent saw. `.gitignore` excludes `.rei/` by default; keep it that way.
