import type { CommandHandler, CommandContext, CommandResult } from "./command-handler.js";
import { loadRole, listRoles } from "../../skills/role-loader.js";
import { runSubAgent } from "../../agent-mode/sub-agent-runner.js";
import { AgentLogger } from "../../core/logger.js";
import { COMMANDS } from "../../cli/constants/chat.constants.js";

/**
 * `/<role-name> <task>` — run a role as a one-shot sub-agent instead of wearing it yourself.
 *
 * A role and a sub-agent are the same definition invoked two ways, differing on ONE axis: whose
 * context it runs in.
 *
 *   /role auditor       → adopt the posture HERE. Shared context, conversational, lasts until
 *                         /role off. You iterate with it.
 *   /auditor @plan.md   → run it in an ISOLATED context. One task, returns a report, your session
 *                         is untouched. Its `preferredModel` applies, so this is also how you get a
 *                         second opinion from a different model without switching yours.
 *
 * The isolation is the reason the task is REQUIRED: the worker cannot see the conversation that
 * invoked it, so "audit it" means nothing there. Name the target.
 *
 * This is the DETERMINISTIC path to a sub-agent — the user fires it. The `delegate` tool remains
 * the model-driven path; neither replaces the other. See docs/roles-spec.md + docs/sub-agent-spec.md.
 */

const INVOKE_RE = /^\/([A-Za-z][\w-]*)(?:\s+([\s\S]+))?$/;

/**
 * Command names that belong to REI itself. The dynamic handler runs LAST, so a static command
 * already wins the collision — this makes the loser explicit instead of silently dead, and lets
 * `/roles` warn about a role nobody can invoke.
 */
export const RESERVED_COMMAND_NAMES: ReadonlySet<string> = new Set(
  COMMANDS.map((c) => c.command.split(/\s+/)[0].replace(/^\//, "").toLowerCase()),
);

/** The role invocable as `/<name>`, or null — reserved names and unknown roles both yield null. */
export function resolveInvokableRole(command: string, workspacePath: string | undefined) {
  // Roles live on disk, so without a workspace there is no command set to match against. Claiming
  // the input anyway would swallow every unknown command and bury "Unknown command: /foo".
  if (!workspacePath) return null;
  const m = command.trim().match(INVOKE_RE);
  if (!m) return null;
  const name = m[1].toLowerCase();
  if (RESERVED_COMMAND_NAMES.has(name)) return null;
  const role = loadRole(name, workspacePath);
  return role ? { role, task: (m[2] ?? "").trim() } : null;
}

export const roleAgentCommands: CommandHandler = {
  match: (command: string, ctx?: CommandContext) =>
    resolveInvokableRole(command, ctx?.workspacePath) !== null,

  run: async (ctx: CommandContext): Promise<CommandResult> => {
    const resolved = resolveInvokableRole(ctx.command, ctx.workspacePath)!;
    const { role, task } = resolved;

    if (!task) {
      return {
        success: false,
        recordInSession: false,
        response:
          `[REI] /${role.name} needs a task. It runs in an isolated context and cannot see this ` +
          `conversation, so name the target explicitly:\n` +
          `  /${role.name} audit @.rei/plans/my-plan.md\n` +
          `To wear the role in THIS session instead (shared context), use /role ${role.name}.`,
      };
    }

    // A real precondition, not a test accommodation: there is nothing to run the worker on.
    if (!ctx.provider) {
      return {
        success: false,
        recordInSession: false,
        response: `[REI] /${role.name} needs an active provider.`,
      };
    }

    const model = role.preferredModel ? ` · model: ${role.preferredModel}` : "";
    ctx.onStatus?.(`🎭  [REI] Running role '${role.name}' as a sub-agent (${role.baseMode}${model})`);

    const summary = await runSubAgent({
      task,
      role,
      provider: ctx.provider,
      workspacePath: ctx.workspacePath,
      logger: new AgentLogger(ctx.workspacePath),
      mcpRegistry: ctx.mcpRegistry,
      emitStatus: ctx.onStatus,
      // Without this the worker's destructive-command gate has no way to ask, and so never fires.
      elicit: ctx.elicit,
    });

    const scope = role.writeGlob ? `, writes limited to ${role.writeGlob}` : "";
    return {
      success: true,
      // Recorded: the report is the point, and the orchestrator's context grows by the summary only
      // — which is the whole trade a sub-agent makes.
      recordInSession: true,
      response: `[REI] Role '${role.name}' (isolated${scope}):\n\n${summary}`,
    };
  },
};
