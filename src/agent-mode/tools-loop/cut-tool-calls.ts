import type { ToolCall } from "../../providers/model-provider.js";

/**
 * Splits off the tool calls the output-token cap cut mid-arguments.
 *
 * With finish_reason "length" the LAST call is usually half-written JSON. Running it is impossible
 * (the args do not parse), and recording it is worse: the next request re-sends it, and strict
 * chat templates (LM Studio) fail that whole request with a 500 HTML page instead of an answer.
 * Only a "length" finish can cut a call, so any other finish keeps every call untouched — a
 * malformed call from a model that stopped on its own is the dispatcher's to report.
 */
export function splitCutToolCalls(
  finishReason: string,
  toolCalls: ToolCall[],
): { complete: ToolCall[]; cut: ToolCall[] } {
  if (finishReason !== "length") return { complete: toolCalls, cut: [] };
  const complete: ToolCall[] = [];
  const cut: ToolCall[] = [];
  for (const call of toolCalls) {
    (parsesAsJson(call.function.arguments) ? complete : cut).push(call);
  }
  return { complete, cut };
}

function parsesAsJson(args: string): boolean {
  try {
    JSON.parse(args);
    return true;
  } catch {
    return false;
  }
}

/**
 * What the model is told instead of seeing its cut call. Without it the model would either assume
 * the write happened or resend the same oversized call and hit the same cap again.
 */
export function cutToolCallNotice(cut: ToolCall[]): string {
  const names = [...new Set(cut.map((c) => c.function.name))].join(", ");
  return (
    `Your ${names} call was cut off by the output token limit before its arguments were complete, ` +
    "so it was NOT executed and nothing was written. Do not resend it whole: make the change in " +
    "smaller steps — several targeted edit_file calls instead of rewriting a large file at once."
  );
}
