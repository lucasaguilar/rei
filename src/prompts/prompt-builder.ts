import type { SessionMode } from "../chat/types.js";
import { loadLocalRules, loadPrompt } from "./loader.js";

export function buildSystemMessage(
  mode: SessionMode,
  repositorySkeletonMap?: string,
): string {
  const sections: string[] = [
    ...(repositorySkeletonMap ? [repositorySkeletonMap, ""] : []),
    loadPrompt("shared/base"),
    "",
    `Active mode: ${mode}`,
    "",
    loadPrompt("shared/response-rules"),
    "",
    // Inyectamos las reglas locales aquí para que tengan alta prioridad
    loadLocalRules(),
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
