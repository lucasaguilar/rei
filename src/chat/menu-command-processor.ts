import type { ChatSession } from "./types.js";
import type { ModelProvider } from "../providers/model-provider.js";
import type { LiveStatusEvent } from "./commands/command-handler.js";
import type { McpRegistry } from "../tools/mcp/mcp-registry.js";
import { dispatchCommand } from "./commands/registry.js";

export interface CommandResult {
  success: boolean;
  response: string;
  newSession?: ChatSession;
  autoExecute?: { prompt: string };
  recordInSession?: boolean;
  recreateAgent?: boolean;
}

export interface MenuCommandOptions {
  /** Streams live progress to the transcript (for slow commands like /ask-document). */
  onStatus?: (message: string) => void;
  /** Optional live status callback for long-running operations that need in-place progress (e.g. /index). */
  onLiveStatus?: (event: LiveStatusEvent) => void;
  /** The active session's MCP registry, so `/mcp` can toggle servers live. */
  mcpRegistry?: McpRegistry;
}

export async function processMenuCommand(
  command: string,
  session: ChatSession,
  workspacePath: string,
  provider: ModelProvider,
  options?: MenuCommandOptions,
): Promise<CommandResult> {
  const trimmed = command.trim();

  // Thin dispatcher: every command lives in its own handler in ./commands/* (see
  // docs/refactor-plan.md, Phase 1). dispatchCommand returns null only when nothing matches.
  const dispatched = await dispatchCommand({
    command: trimmed,
    session,
    workspacePath,
    provider,
    mcpRegistry: options?.mcpRegistry,
    onStatus: options?.onStatus,
    onLiveStatus: options?.onLiveStatus,
  });
  if (dispatched) return dispatched;

  return {
    success: false,
    response: `Unknown command: ${trimmed}`,
  };
}
