import type { SessionMode } from "../chat/types.js";
import { loadPrompt } from "./loader.js";
import { buildAgentContractBlock } from "../contracts/agent-response.types.js";

export function buildSystemMessage(mode: SessionMode): string {
  const sections: string[] = [
    loadPrompt("shared/base"),
    "",
    `Active mode: ${mode}`,
    "",
  ];

  // For agent mode, inject the JSON contract BEFORE the general response rules
  // so its "override all response rules" instruction takes priority.
  if (mode === "agent") {
    sections.push(buildAgentContractBlock(), "");
  } else {
    sections.push(loadPrompt("shared/response-rules"), "");
  }

  sections.push(loadPrompt(`modes/${mode}`), "");
  sections.push(loadPrompt(`formats/${mode}-format`));

  return sections.join("\n");
}