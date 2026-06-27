import type { CommandResult } from "../menu-command-processor.js";
import type { ChatSession } from "../types.js";
import type { ModelProvider } from "../../providers/model-provider.js";

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
  /** Streams live progress to the transcript (for slow commands like /ask-document). */
  onStatus?: (message: string) => void;
}

/** A self-contained command, or a group of related commands. */
export interface CommandHandler {
  /** True when this handler owns the input. MUST be exact to stay behavior-preserving — an input
   *  it doesn't fully own should return false so it falls through to the legacy dispatcher. */
  match(command: string): boolean;
  run(ctx: CommandContext): Promise<CommandResult> | CommandResult;
}
