import type { SessionMode } from "../chat/types.js";
import { loadPrompt } from "./loader.js";
import { buildAgentContractBlock } from "../contracts/agent-response.types.js";

export function buildSystemMessage(mode: SessionMode): string {
  const sections: string[] = [
    loadPrompt("shared/base"),
    "",
    `Active mode: ${mode}`,
    "",
    loadPrompt("shared/response-rules"),
    "",
    loadPrompt(`modes/${mode}`),
    "",
  ];

  // Inject the structured JSON contract programmatically for agent mode.
  // This keeps the contract machine-verifiable in TypeScript while keeping
  // prose instructions in the markdown files.
  if (mode === "agent") {
    sections.push(buildAgentContractBlock(), "");
  }

  sections.push(loadPrompt(`formats/${mode}-format`));

  return sections.join("\n");
}