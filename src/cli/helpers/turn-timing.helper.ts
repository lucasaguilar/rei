/**
 * What the ⏱️ line under a turn reports: preparation, time-to-first-token, and tokens per second.
 *
 * The speed used to be `tokens ÷ (endTime − firstTokenTime)`, which assumes tokens were WATCHED
 * arriving. When the response lands in one piece — a non-streaming fallback, or text buffered and
 * flushed at the end — those two instants are the same, the window collapses to the 1ms floor that
 * exists to avoid dividing by zero, and the line read `Speed: 693000.0 tok/s` next to
 * `TTFT: 75.76s`. That is not a fast turn; it is an unmeasured one.
 */

/** Under this, no stream was really observed: the answer arrived in one piece. */
const MIN_MEASURABLE_STREAM_MS = 50;

export interface TurnTiming {
  /** Everything before the model was called: context building, scans, compaction. */
  prepMs: number;
  /** From the call to the first token the UI saw. */
  ttftMs: number;
  /** The window the speed is measured over. */
  generationMs: number;
  /** Tokens per second, with " avg" when it covers the whole wait instead of a real stream. */
  speedText: string;
}

export function turnTiming(params: {
  firstTokenTime: number;
  endTime: number;
  callingModelTime: number;
  startTime: number;
  outputTokens: number;
}): TurnTiming {
  const { endTime, callingModelTime, startTime, outputTokens } = params;
  // No token was ever seen: the whole answer landed at the end.
  const firstTokenTime = params.firstTokenTime < 0 ? endTime : params.firstTokenTime;

  const prepMs = callingModelTime > 0 ? Math.max(0, callingModelTime - startTime) : 0;
  const ttftMs =
    callingModelTime > 0
      ? Math.max(0, firstTokenTime - callingModelTime)
      : Math.max(0, firstTokenTime - startTime);

  const observedMs = endTime - firstTokenTime;
  const streamWasObserved = observedMs >= MIN_MEASURABLE_STREAM_MS;
  // Falling back to the whole model window INCLUDES the wait before the first token, so it
  // understates decode speed — but an understated real number beats an invented one.
  const generationMs = Math.max(
    1,
    streamWasObserved
      ? observedMs
      : endTime - (callingModelTime > 0 ? callingModelTime : startTime),
  );

  const value = outputTokens / (generationMs / 1000);
  const formatted = value > 0 && value < 0.1 ? "<0.1" : value.toFixed(1);
  // Marked when averaged, so a number that looks low reads as "measured differently" rather than
  // "the model got slower".
  return {
    prepMs,
    ttftMs,
    generationMs,
    speedText: `${formatted} tok/s${streamWasObserved ? "" : " avg"}`,
  };
}
