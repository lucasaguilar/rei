import { paint } from "../theme/palette.js";
import type { InputHandlerContext } from "../models/input-handler.types.js";
import { runShellCommand } from "./run-shell-command.js";
import { formatReceiptForModel, receiptLabel } from "./shell-receipt.js";

// What a receipt keeps of the output. Past this the model would get a spill receipt anyway, and
// holding an unbounded `!cat huge.log` in memory for a /attach that may never come is waste.
const MAX_CAPTURE_CHARS = 1_000_000;

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

  // Only the LAST command can be attached. Replacing one the user had attached must be said out
  // loud — otherwise they send their next message believing the model sees the old output.
  const previous = state.shellReceipt;
  if (previous?.attached) {
    actions.pushTranscript(
      paint("warn", `🧾 ${previous.command} is no longer attached — /attach applies to the last command`),
    );
  }
  state.shellReceipt = undefined;

  actions.pushTranscript(paint("user", `$ ${command}`));

  // Output arrives in arbitrary chunks; the transcript is line-based, so a partial line waits
  // for the rest of itself instead of being printed as two.
  let pending = "";
  let captured = "";
  const onOutput = (chunk: string) => {
    if (captured.length < MAX_CAPTURE_CHARS) captured += chunk.slice(0, MAX_CAPTURE_CHARS - captured.length);
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
    state.shellReceipt = { command, ...result, output: captured, attached: false };

    const took = formatDuration(result.durationMs);
    const tail = `${took} · not sent to the model · /attach to hand it over`;
    if (result.aborted) {
      actions.pushTranscript(paint("warn", `↳ stopped (Ctrl+C) · ${tail}`));
    } else {
      const role = result.exitCode === 0 ? "dim" : "warn";
      actions.pushTranscript(paint(role, `↳ exit ${result.exitCode ?? "?"} · ${tail}`));
    }
  } finally {
    state.shellAbort = undefined;
  }
}

/**
 * `/attach` and `/detach`. Handled here, in the CLI, and not in src/chat/commands: that registry is
 * shared with the HTTP server, which has no shell and must never grow one. Returns true when the
 * input was one of them.
 */
export function handleReceiptCommand(trimmed: string, ctx: InputHandlerContext): boolean {
  if (trimmed !== "/attach" && trimmed !== "/detach") return false;
  const { state, actions } = ctx;
  const receipt = state.shellReceipt;
  if (!receipt) {
    actions.pushTranscript(paint("dim", "Nothing to attach — run a !command first."));
    return true;
  }
  receipt.attached = trimmed === "/attach";
  actions.pushTranscript(
    paint(
      "dim",
      receipt.attached
        ? `🧾 ${receiptLabel(receipt)} goes with your next message · /detach to drop it`
        : `🧾 ${receipt.command} detached — the model will not see it`,
    ),
  );
  return true;
}

/**
 * The attached receipt as a block to prepend to the prompt, or null. Taking it clears it: the
 * evidence rides on ONE message — re-sent on every later one it would be context paid for twice.
 */
export function takeAttachedReceipt(state: InputHandlerContext["state"]): string | null {
  const receipt = state.shellReceipt;
  if (!receipt?.attached) return null;
  state.shellReceipt = undefined;
  return formatReceiptForModel(receipt);
}

function formatDuration(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}
