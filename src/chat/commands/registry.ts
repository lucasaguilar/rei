import type { CommandContext, CommandResult } from "./command-handler.js";
import { sessionCommands } from "./session-commands.js";
import { documentCommands } from "./document-commands.js";
import { miscCommands } from "./misc-commands.js";

/**
 * The command registry. Commands are migrated out of menu-command-processor's big if/else into
 * small per-group handlers here, incrementally (see docs/refactor-plan.md, Phase 1). Anything not
 * yet migrated returns null from dispatch and falls back to the legacy dispatcher.
 */
const COMMAND_HANDLERS = [sessionCommands, documentCommands, miscCommands];

/** Runs the first handler that owns the input, or null when none does (→ legacy fallback). */
export async function dispatchCommand(
  ctx: CommandContext,
): Promise<CommandResult | null> {
  for (const handler of COMMAND_HANDLERS) {
    if (handler.match(ctx.command)) {
      return await handler.run(ctx);
    }
  }
  return null;
}
