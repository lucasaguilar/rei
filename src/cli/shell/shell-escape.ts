import { paint } from "../theme/palette.js";
import type { InputHandlerContext } from "../models/input-handler.types.js";
import { runShellCommand } from "./run-shell-command.js";

/**
 * `!cmd` → "cmd"; a bare `!` → ""; anything else → null.
 * Only a LEADING `!` counts: "why does !x fail?" is a question for the model, not a command.
 */
export function parseShellEscape(input: string): string | null {
  const trimmed = input.trim();
  return trimmed.startsWith("!") ? trimmed.slice(1).trim() : null;
}

const USAGE =
  "Type a command after ! — e.g. !git status. It runs in your shell, in the workspace, and the " +
  "model never sees it. Interactive programs (vim, less, git add -p) are not supported yet.";

/**
 * Runs a `!cmd` the user typed and shows its output in the transcript. Nothing is added to the
 * session: the point is a `git status` that costs milliseconds instead of an inference turn, and
 * that leaves the model's context exactly as it was.
 */
export async function handleShellEscape(
  command: string,
  ctx: InputHandlerContext,
): Promise<void> {
  const { state, actions, workspacePath } = ctx;
  if (!command) {
    actions.pushTranscript(paint("dim", USAGE));
    return;
  }

  actions.pushTranscript(paint("user", `$ ${command}`));

  // Output arrives in arbitrary chunks; the transcript is line-based, so a partial line waits
  // for the rest of itself instead of being printed as two.
  let pending = "";
  const onOutput = (chunk: string) => {
    const lines = (pending + chunk).split("\n");
    pending = lines.pop() ?? "";
    if (lines.length > 0) actions.pushTranscript(lines.join("\n"));
  };

  const controller = new AbortController();
  state.shellAbort = () => controller.abort();
  try {
    const result = await runShellCommand(command, {
      cwd: workspacePath,
      onOutput,
      signal: controller.signal,
    });
    if (pending) actions.pushTranscript(pending);

    const took = formatDuration(result.durationMs);
    if (result.aborted) {
      actions.pushTranscript(paint("warn", `↳ stopped (Ctrl+C) · ${took} · not sent to the model`));
    } else {
      const role = result.exitCode === 0 ? "dim" : "warn";
      actions.pushTranscript(
        paint(role, `↳ exit ${result.exitCode ?? "?"} · ${took} · not sent to the model`),
      );
    }
  } finally {
    state.shellAbort = undefined;
  }
}

function formatDuration(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}
