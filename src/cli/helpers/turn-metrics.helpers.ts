import type { ChatSession } from "../../chat/types.js";
import type { Agent } from "../../core/agent.js";
import { formatContextGauge } from "../markdown-renderer.js";
import { code, RESET } from "../theme/palette.js";
import { getContextWindow } from "../../config/model-runtime.js";
import { turnTiming } from "./turn-timing.helper.js";
import { resolveActiveModelLabel } from "./model-label.helper.js";
import { publishContextReading, type PhaseState } from "./turn-display.helpers.js";

/** When each landmark of the turn happened — the timing line is built from the gaps between them. */
export interface TurnTimings {
  firstTokenTime: number;
  endTime: number;
  callingModelTime: number;
  startTime: number;
}

/**
 * What a finished turn reports: the context gauge, the sticky bar reading, and the timing line.
 *
 * Split out of the turn handler because it answers a different question — the handler is about
 * driving the stream, this is about accounting for it once the stream is done.
 */
export function reportTurnMetrics(params: {
  state: PhaseState;
  session: ChatSession;
  agent: Pick<Agent, "getLastTurnUsage" | "getLastTurnModel" | "estimateActiveToolsTokens">;
  pushTranscript: (line: string) => void;
  totalOutputChars: number;
  timings: TurnTimings;
}): void {
  const { state, session, agent, pushTranscript, totalOutputChars } = params;
  const { firstTokenTime, endTime, callingModelTime, startTime } = params.timings;

  // Token counts: prefer the backend's REAL usage (aggregated across the turn's model calls);
  // fall back to the chars/4 estimate when the provider doesn't report it.
  const realUsage = agent.getLastTurnUsage();
  let sentTokens: number;
  let recTokens: number;
  if (realUsage) {
    // Real numbers from the backend — no `~`, and the tools array is already counted in
    // promptTokens (the backend tokenized it), so no separate tools estimate is added.
    // The LAST call's prompt, not the turn's peak: after a compaction the peak is a state that no
    // longer exists, and this number is what the sticky bar carries into the next turn.
    sentTokens = realUsage.lastPromptTokens ?? realUsage.promptTokens ?? 0;
    recTokens =
      realUsage.completionTokens ??
      Math.max(1, Math.round(totalOutputChars / 4));
  } else {
    // Approximate token counts (1 token ~= 4 chars in mixed code/text prompts)
    const inputMsgs = session.messages.slice(0, -1);
    const inputChars = inputMsgs.reduce(
      (acc, m) => acc + m.content.length,
      0,
    );
    const historyTokens = Math.round(inputChars / 4);
    // The function-calling tools array (built-in + MCP schemas) is sent on every agent
    // request but is NOT in the message history — include it so the gauge reflects real
    // context usage. Large MCP servers can occupy a big share of the window invisibly.
    const toolsTokens = agent.estimateActiveToolsTokens(session.mode);
    sentTokens = historyTokens + toolsTokens;
    recTokens = Math.max(1, Math.round(totalOutputChars / 4));
  }

  const timing = turnTiming({
    firstTokenTime,
    endTime,
    callingModelTime,
    startTime,
    outputTokens: recTokens,
  });
  const { prepMs, ttftMs, speedText } = timing;

  const activeModel = resolveActiveModelLabel(
    session.mode,
    agent.getLastTurnModel(),
  );

  // Visual context-usage gauge: how much of the assumed window the prompt consumed this turn.
  // Helps spot when history/files are about to overflow (and explains slow prefill).
  const gauge = formatContextGauge(
    sentTokens,
    getContextWindow(),
    activeModel,
  );
  if (gauge) pushTranscript(`\n${gauge}`);
  publishContextReading(state, sentTokens, getContextWindow(), activeModel);

  // `~` marks estimated counts; real backend-reported numbers are shown bare.
  const approx = realUsage ? "" : "~";
  // `tok in` is now the LAST prompt, so a turn that compacted would otherwise hide how big it got
  // before the cut — which is the number that explains a slow prefill. Shown only when the two
  // actually differ, i.e. when the history shrank mid-turn.
  const peak = realUsage?.promptTokens;
  const peakNote = peak && peak > sentTokens ? ` (peak ${peak})` : "";
  pushTranscript(
    `${gauge ? "" : "\n"}${code("muted")}⏱️  Prep: ${(prepMs / 1000).toFixed(2)}s | TTFT(model): ${(ttftMs / 1000).toFixed(2)}s | Speed: ${speedText} | Tokens: ${approx}${sentTokens}${peakNote} tok in, ${approx}${recTokens} tok out${RESET}`,
  );
  pushTranscript("");
}
