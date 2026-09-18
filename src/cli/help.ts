import { getVersion } from "./version.js";

/**
 * The one place the CLI's surface is written down.
 *
 * It was written down twice before — in the bash launcher the installers generate, and nowhere
 * else — and the copy drifted: it advertised `rei plan "<task>"` while the launcher hardcoded
 * `chat`, and it never learned about `ask`, `agent`, or any of the session flags. The launcher now
 * delegates `--help` here, so there is nothing left to keep in step.
 */
export function helpText(): string {
  return `REI ${getVersion()} — a local-first coding agent.

Usage:
  rei                            Interactive session in the current directory
  rei ask     "<question>"       One-shot: answer, no edits
  rei plan    "<task>"           One-shot: a plan, no edits
  rei agent   "<task>"           One-shot: do the work, edits files
  rei --config                   Re-run the setup wizard

One-shot output goes to stdout and nothing else, so it pipes.

Session:
  -s, --session <name>           Open (or create) a named session
  -c, --continue                 Resume the most recently updated session
      --force                    Steal the lock if another terminal holds it
      --workspace <path>         Project directory (default: the current one)
      --no-auto-index            Skip the startup repo index

Output:
      --metrics                  Timings and token counts, on stderr
      --verbose                  Full tool output and diffs (reasoning is on by default)
      --version                  Print the version and exit
  -h, --help                     This text

Configuration lives in .rei/.env and rei.config.json inside the project.
Docs: https://github.com/lucasaguilar/rei`;
}
