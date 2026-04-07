import type { SessionMode } from "../chat/types.js";
import { loadPrompt } from "./loader.js";

export function buildSystemMessage(mode: SessionMode): string {
  const sections: string[] = [
    loadPrompt("shared/base"),
    "",
    `Active mode: ${mode}`,
    "",
    loadPrompt("shared/response-rules"),
    "",
  ];

  if (mode === "agent") {
    sections.push(loadPrompt("modes/agent"));
  } else {
    sections.push(loadPrompt(`modes/${mode}`), "");
    sections.push(loadPrompt(`formats/${mode}-format`));
  }

  return sections.join("\n");
}
