import { Agent } from "../core/agent.js";
import type { ChatSession, SessionMode } from "../chat/types.js";

/**
 * One prompt, one turn — the non-interactive entry point.
 *
 * `rei plan` existed but did NOT exercise REI: planningSkill called `agent.run()`, which goes
 * straight to `provider.complete()` with no system prompt, no tools, no repo context and no skills.
 * It measured the bare model. This runs the real path (`streamTurn`), so the output is what the
 * interactive CLI would produce.
 *
 * stdout carries ONLY the final answer. The turn also emits tool statuses, the model's thinking, and
 * the narration it writes between tool calls ("Let me read X first…") — all useful live, all noise
 * in a captured result. A measured run showed 2.8k of 13.3k chars were narration and status; piped
 * to a file or diffed against another agent, that is pure contamination.
 *
 * The stream marks its chunks (\x10 thinking, \x11 text, unmarked status), and a status means a tool
 * ran — so text written BEFORE one is narration about work still to come, and only the block after
 * the last tool call is the answer.
 */
export interface OneShotOptions {
  /** Print timing/token metrics to stderr. */
  metrics?: boolean;
  /** Mirror thinking, statuses and narration to stderr instead of dropping them. */
  verbose?: boolean;
}

const THINKING = "\x10";
const TEXT = "\x11";

export async function runOneShot(
  agent: Agent,
  workspacePath: string,
  mode: SessionMode,
  prompt: string,
  options: OneShotOptions = {},
): Promise<void> {
  const session: ChatSession = { messages: [], mode };
  const trace = (s: string): void => {
    if (options.verbose) process.stderr.write(s);
  };

  const start = Date.now();
  let firstToken: number | undefined;
  let answer = ""; // text since the last tool call — the final block wins
  let narration = 0;
  let statuses = 0;

  for await (const chunk of agent.streamTurn(session, prompt)) {
    if (firstToken === undefined) firstToken = Date.now();

    if (chunk.startsWith(THINKING)) {
      trace(chunk.slice(1));
      continue;
    }
    if (chunk.startsWith(TEXT)) {
      answer += chunk.slice(1);
      continue;
    }
    // Unmarked = a tool status: whatever text preceded it was narration about work still to come.
    statuses++;
    narration += answer.length;
    trace(answer + chunk);
    answer = "";
  }

  process.stdout.write(answer.trim() + "\n");

  if (!options.metrics) return;

  const total = (Date.now() - start) / 1000;
  const ttft = firstToken ? (firstToken - start) / 1000 : total;
  const usage = agent.getLastTurnUsage();
  const out = usage?.completionTokens;
  const speed = out && total > ttft ? (out / (total - ttft)).toFixed(1) : "n/a";

  process.stderr.write(
    `\n[metrics] mode=${mode} ttft=${ttft.toFixed(2)}s total=${total.toFixed(2)}s ` +
      `in=${usage?.promptTokens ?? "n/a"} out=${out ?? "n/a"} ` +
      `answer=${answer.trim().length} narration=${narration} tools=${statuses} ` +
      `speed=${speed} tok/s\n`,
  );
}
