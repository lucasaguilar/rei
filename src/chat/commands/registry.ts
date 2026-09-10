import type { CommandContext, CommandResult } from "./command-handler.js";
import { sessionCommands } from "./session-commands.js";
import { documentCommands } from "./document-commands.js";
import { activeDocumentCommands } from "./active-document-commands.js";
import { miscCommands } from "./misc-commands.js";
import { specCommands } from "./spec-commands.js";
import { runPlanCommand, planFileCommands } from "./plan-commands.js";
import { providerCommands } from "./provider-commands.js";
import { treeCommands } from "./tree-commands.js";
import { roleCommands } from "./role-commands.js";
import { mcpCommands } from "./mcp-commands.js";
import { thinkCommands } from "./think-commands.js";
import { sddCommands } from "./sdd-commands.js";
import { activeCommands } from "./active-commands.js";
import { traceCommands } from "./trace-commands.js";
import { verboseCommands } from "./verbose-commands.js";
import { roleAgentCommands } from "./role-agent-commands.js";

/**
 * The command registry. Commands are migrated out of menu-command-processor's big if/else into
 * small per-group handlers here, incrementally (see docs/refactor-plan.md, Phase 1). Anything not
 * yet migrated returns null from dispatch and falls back to the legacy dispatcher.
 */
const COMMAND_HANDLERS = [
  sessionCommands,
  documentCommands,
  activeDocumentCommands,
  miscCommands,
  specCommands,
  runPlanCommand,
  planFileCommands,
  providerCommands,
  treeCommands,
  roleCommands,
  mcpCommands,
  thinkCommands,
  sddCommands,
  activeCommands,
  traceCommands,
  verboseCommands,
  // LAST on purpose: it matches `/<role-name>`, which is whatever is on disk. Every static command
  // above therefore wins a name collision, and a role that shadows one simply never fires — which
  // `/roles` reports rather than leaving you to wonder.
  roleAgentCommands,
];

/**
 * Runs the first handler that owns the input, or null when none does (→ legacy fallback).
 *
 * A handler that throws is reported as a failed command, NOT propagated: an unhandled rejection here
 * escapes to the top level and kills the whole CLI (a malformed rei.config.json entry once took the
 * session down through `/mcp`). Losing one command is recoverable; losing the session is not.
 */
export async function dispatchCommand(
  ctx: CommandContext,
): Promise<CommandResult | null> {
  for (const handler of COMMAND_HANDLERS) {
    if (handler.match(ctx.command, ctx)) {
      try {
        return await handler.run(ctx);
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        return {
          success: false,
          response: `[REI] ❌ '${ctx.command.split(/\s+/)[0]}' failed: ${detail}`,
          recordInSession: false,
        };
      }
    }
  }
  return null;
}
