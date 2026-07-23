import type { ElicitFn, Elicitation } from "../chat/elicitation.js";

/**
 * Transcript-based elicitation for the interactive CLI. Instead of introducing a SECOND keyboard
 * owner (@clack) mid-turn — which would fight REI's session-global keypress listener — the question
 * is printed to REI's own transcript and the answer comes back through REI's OWN input: the turn
 * pauses (busy=false so the prompt shows and typing works), the next submitted line resolves the
 * pending question, and the turn resumes. Mirrors how a frontier harness bubbles the request up to
 * the single I/O owner rather than grabbing the keyboard from deep in the stack.
 * See docs/intent-router-spec.md.
 */

export interface CliElicitDeps {
  pushTranscript: (line: string) => void;
  /** Toggles the turn's "busy" UI: false shows the input prompt + enables typing, true resumes. */
  setBusy: (busy: boolean) => void;
  stopSpinner: () => void;
  draw: () => void;
}

function renderQuestion(req: Elicitation): string {
  const q = `\x1b[36m❓ ${req.message}\x1b[0m`;
  if (req.kind === "select" && req.options?.length) {
    const opts = req.options
      .map((o, i) => `  \x1b[36m${i + 1})\x1b[0m ${o.label}`)
      .join("\n");
    // Advertise the free-text escape hatch (like a frontier "Other" option): any answer that
    // isn't a number/option is passed to the model verbatim; empty Enter skips.
    return `${q}\n${opts}\n\x1b[90m(pick a number, or just write your own answer — empty = skip)\x1b[0m`;
  }
  if (req.kind === "confirm") {
    return `${q}\n\x1b[90m(y / n · sí / no — empty = ${req.default})\x1b[0m`;
  }
  return `${q}\n\x1b[90m(type your answer, or empty = skip, then Enter)\x1b[0m`;
}

/** Maps a free-typed line to a value. For a select, accept a 1-based number, or a value/label
 *  (case-insensitive); an unrecognized answer falls back to the safe default. */
export function normalizeAnswer(req: Elicitation, line: string): string {
  const answer = line.trim();
  if (req.kind === "confirm") {
    // Bilingual yes/no. Empty or unrecognized → the safe default (the gate handler checks === "yes").
    if (/^(y|yes|ye|yeah|s|si|sí|ok|okay|dale|sip|1)$/i.test(answer)) return "yes";
    if (/^(n|no|nope|nel|0)$/i.test(answer)) return "no";
    return req.default;
  }
  if (req.kind === "select" && req.options?.length) {
    const n = Number(answer);
    if (Number.isInteger(n) && n >= 1 && n <= req.options.length) {
      return req.options[n - 1].value;
    }
    const match = req.options.find(
      (o) =>
        o.value.toLowerCase() === answer.toLowerCase() ||
        o.label.toLowerCase() === answer.toLowerCase(),
    );
    if (match) return match.value;
    // Unrecognized non-empty answer: pass the raw text through (honest — the model hears what the
    // user actually said, e.g. "neither, I want red"). An empty Enter returns "" = a clean skip,
    // which the handler surfaces to the model as "the user declined to answer". req.default is only
    // for the headless path (nonInteractiveElicit), which never reaches here.
    return answer;
  }
  // Free-form: the typed text verbatim, or "" (empty Enter) = a clean skip.
  return answer;
}

export class CliElicitation {
  private pending?: {
    req: Elicitation;
    resolve: (r: { id: string; value: string }) => void;
  };

  constructor(private deps: CliElicitDeps) {}

  /** True while a question awaits an answer — the input loop routes the next line to `deliver`. */
  get isPending(): boolean {
    return this.pending !== undefined;
  }

  /** The ElicitFn injected into the agent turn: render the question, pause, await the next input. */
  readonly elicit: ElicitFn = (req) =>
    new Promise((resolve) => {
      this.pending = { req, resolve };
      this.deps.pushTranscript(renderQuestion(req));
      this.deps.stopSpinner();
      this.deps.setBusy(false); // pause the turn UI: show the prompt + allow typing
      this.deps.draw();
    });

  /** Feed the next submitted input line; returns true if it answered a pending question. Resumes
   *  the turn into STREAMING mode: busy=true, and — critically — NO spinner/draw here. Content is
   *  already flowing, so the spinner stays off (input-turn stops it at first content); restarting it
   *  would make its 100ms draw() repaint the input block over the streamed text. The echo pushed by
   *  the caller already cleared the prompt, so streamed tokens append cleanly. */
  deliver(line: string): boolean {
    if (!this.pending) return false;
    const { req, resolve } = this.pending;
    this.pending = undefined;
    this.deps.setBusy(true); // the turn resumes in streaming mode
    resolve({ id: req.id, value: normalizeAnswer(req, line) });
    return true;
  }
}
