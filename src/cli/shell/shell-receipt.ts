import { maskSecrets } from "../../tools/secret-masking.js";
import { retainAndMaybeSpill } from "../../agent-mode/tools-loop/tool-output-store.js";

/**
 * What REI captured of the last `!cmd`: the command, how it ended and everything it printed.
 * `attached` is the user's decision to hand it to the model with their next message.
 */
export interface ShellReceipt {
  command: string;
  exitCode: number | null;
  aborted: boolean;
  durationMs: number;
  output: string;
  attached: boolean;
}

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

/** `npm test (exit 1 · 3.1k)` — enough to recognise it above the prompt without reading it. */
export function receiptLabel(r: ShellReceipt): string {
  const end = r.aborted ? "stopped" : `exit ${r.exitCode ?? "?"}`;
  const n = r.output.length;
  const size = n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n} chars`;
  return `${r.command} (${end} · ${size})`;
}

/**
 * The receipt as the model receives it.
 *
 * Framed as evidence, not as something the user says: REI captured the command, exit code and
 * output itself, so unlike pasted text it cannot be misquoted — and a model that doubts it would
 * re-run `npm test` "to confirm", spending exactly the turn this feature exists to save.
 *
 * On the way out it gets what tool output gets: colour codes stripped (they were for human eyes),
 * secrets masked (an attached `!env` would otherwise ship API keys to a cloud provider), and the
 * same inline budget, so a 20k-line log is spilled to disk rather than flooding the window.
 */
export function formatReceiptForModel(r: ShellReceipt): string {
  const end = r.aborted ? "stopped with Ctrl+C" : `exit ${r.exitCode ?? "?"}`;
  const seconds = (r.durationMs / 1000).toFixed(1);
  const output = retainAndMaybeSpill(
    "shell_escape",
    maskSecrets(r.output.replace(ANSI, "")).trimEnd(),
  );
  return (
    "[Verified — the user ran this in their own shell; REI captured the command, exit code and " +
    "output. Treat it as fact; do not re-run it to confirm.]\n" +
    `$ ${r.command}   (${end}, ${seconds}s)\n` +
    (output || "(no output)")
  );
}
