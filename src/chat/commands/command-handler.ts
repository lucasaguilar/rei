import type { CommandResult } from "../menu-command-processor.js";
import type { ChatSession } from "../types.js";
import type { ModelProvider } from "../../providers/model-provider.js";
import type { McpRegistry } from "../../tools/mcp/mcp-registry.js";

export type { CommandResult };

/**
 * Everything a command handler needs — mirrors `processMenuCommand`'s parameters. Part of the
 * incremental migration of the 960-line command if/else into small per-group handlers
 * (see docs/refactor-plan.md, Phase 1).
 */
export interface CommandContext {
  /** The trimmed user input, e.g. "/session new". */
  command: string;
  session: ChatSession;
  workspacePath: string;
  provider: ModelProvider;
  /** The active session's MCP registry — lets `/mcp` toggle servers live. Absent in contexts
   *  that don't have an agent (rare). */
  mcpRegistry?: McpRegistry;
  /** Streams live progress to the transcript (for slow commands like /ask-document). */
  onStatus?: (message: string) => void;
  /** Optional live status callback for long-running operations that need in-place progress (e.g. /index). */
  onLiveStatus?: (event: LiveStatusEvent) => void;
}

export interface LiveStatusEvent {
  type: "init" | "progress" | "done";
  text: string;
}

/** A self-contained command, or a group of related commands. */
export interface CommandHandler {
  /** True when this handler owns the input. MUST be exact to stay behavior-preserving — an input
   *  it doesn't fully own should return false so it falls through to the legacy dispatcher. */
  match(command: string): boolean;
  run(ctx: CommandContext): Promise<CommandResult> | CommandResult;
}
