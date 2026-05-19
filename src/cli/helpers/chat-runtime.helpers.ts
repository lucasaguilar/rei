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
