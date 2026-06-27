import type { ChatSession } from "./types.js";
import type { ModelProvider } from "../providers/model-provider.js";
import { dispatchCommand } from "./commands/registry.js";

export interface CommandResult {
  success: boolean;
  response: string;
  newSession?: ChatSession;
  autoExecute?: { prompt: string };
  recordInSession?: boolean;
  recreateAgent?: boolean;
}

export async function processMenuCommand(
  command: string,
  session: ChatSession,
  workspacePath: string,
  provider: ModelProvider,
  onStatus?: (message: string) => void,
): Promise<CommandResult> {
  const trimmed = command.trim();

  // Thin dispatcher: every command lives in its own handler in ./commands/* (see
  // docs/refactor-plan.md, Phase 1). dispatchCommand returns null only when nothing matches.
  const dispatched = await dispatchCommand({
    command: trimmed,
    session,
    workspacePath,
    provider,
    onStatus,
  });
  if (dispatched) return dispatched;

  return {
    success: false,
    response: `Unknown command: ${trimmed}`,
  };
}
