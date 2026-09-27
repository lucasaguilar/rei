import { spawn } from "node:child_process";

export interface ShellRunResult {
  /** null when the process was killed by a signal (an abort, typically). */
  exitCode: number | null;
  aborted: boolean;
  durationMs: number;
}

export interface ShellRunOptions {
  cwd: string;
  onOutput: (chunk: string) => void;
  signal?: AbortSignal;
  /** Defaults to the user's login shell: this is THEIR command, with their shell's syntax. */
  shell?: string;
}

// Grace period between SIGINT and SIGKILL — enough for a well-behaved tool to clean up.
const KILL_GRACE_MS = 1500;

/**
 * Runs a command the USER typed (`!cmd`), in their real shell, inside the workspace.
 *
 * Unlike run_command this is not the model's tool, so there is no allow-list: it has exactly the
 * power of the user's own terminal. That is also why it lives under src/cli/ and nothing the HTTP
 * server loads may import it.
 *
 * There is no TTY — output is piped into REI's transcript — so anything that would wait on one is
 * made to finish instead: stdin is closed, pagers print straight through, and git's editor fails
 * with a message rather than opening vi where nobody can see it.
 */
export function runShellCommand(
  command: string,
  opts: ShellRunOptions,
): Promise<ShellRunResult> {
  const started = Date.now();
  const shell = opts.shell ?? process.env.SHELL ?? "/bin/sh";

  return new Promise((resolve) => {
    const child = spawn(shell, ["-c", command], {
      cwd: opts.cwd,
      env: {
        ...process.env,
        PAGER: "cat",
        GIT_PAGER: "cat",
        GIT_EDITOR: "false",
        // Tools that colour only on a TTY still colour here: the output is for human eyes.
        FORCE_COLOR: "1",
        CLICOLOR_FORCE: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
      // Own process group, so an abort reaches every stage of a pipeline — killing only the
      // shell would leave `sleep 30 | cat` running, orphaned, after REI said it stopped.
      detached: true,
    });

    let aborted = false;
    let killTimer: NodeJS.Timeout | undefined;
    const killGroup = (sig: NodeJS.Signals) => {
      try {
        if (child.pid) process.kill(-child.pid, sig);
      } catch {
        /* already gone */
      }
    };
    const onAbort = () => {
      aborted = true;
      killGroup("SIGINT");
      killTimer = setTimeout(() => killGroup("SIGKILL"), KILL_GRACE_MS);
    };
    if (opts.signal?.aborted) onAbort();
    else opts.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.setEncoding("utf8").on("data", opts.onOutput);
    child.stderr.setEncoding("utf8").on("data", opts.onOutput);

    const finish = (exitCode: number | null) => {
      if (killTimer) clearTimeout(killTimer);
      opts.signal?.removeEventListener("abort", onAbort);
      resolve({ exitCode, aborted, durationMs: Date.now() - started });
    };
    child.on("error", (err) => {
      opts.onOutput(`${err.message}\n`);
      finish(127);
    });
    child.on("close", (code) => finish(code));
  });
}
