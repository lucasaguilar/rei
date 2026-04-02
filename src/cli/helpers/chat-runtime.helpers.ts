import type { ChatUIState } from "../models/chat.types.js";

export function appendTranscriptLines(
  transcript: string[],
  value: string,
  maxLines = 3000,
): void {
  const normalized = value.replace(/\r\n/g, "\n");
  for (const line of normalized.split("\n")) {
    transcript.push(line);
  }

  if (transcript.length > maxLines) {
    transcript.splice(0, transcript.length - maxLines);
  }
}

export function applyMouseWheelScroll(
  data: string,
  state: ChatUIState,
  step: number,
): boolean {
  if (!data.includes("\x1b[<") && !data.includes("\x1b[M")) {
    return false;
  }

  const matches = data.matchAll(/\x1b\[<(\d+);(\d+);(\d+)([mM])/g);
  let changed = false;

  for (const match of matches) {
    const code = Number(match[1]);
    if (Number.isNaN(code)) continue;

    if (code === 64) {
      state.scrollOffset += step;
      changed = true;
    } else if (code === 65) {
      state.scrollOffset = Math.max(0, state.scrollOffset - step);
      changed = true;
    }
  }

  return changed;
}
