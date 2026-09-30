/**
 * The confirm gate on MCP tool calls — the counterpart of command-gates.ts for run_command.
 *
 * run_command had deterministic confirms (rm, git reset --hard, git push…) while every `mcp:*` call
 * went straight to the server: with Google Workspace connected, a model asked to "summarise Juan's
 * mail" could call `gmail/send_message` and the mail was gone, unasked. On the HTTP server, anyone
 * who could POST a prompt could trigger it.
 *
 * The decision uses the server's own `annotations` first — a declared fact, not a guess — and only
 * falls back to the verb in the tool's name when the server declares nothing, which most do.
 */
import type { AgentLogger } from "../../core/logger.js";
import type { McpTool } from "../../tools/mcp/mcp-client.js";
import { newElicitationId, nonInteractiveElicit, type ElicitFn } from "../../chat/elicitation.js";

// Verbs that change something. Matched as whole words of the tool name (split on _ - / . and
// camelCase), because substring matching made `get_settings` a "set" and `lookup_address` an "add".
const MUTATING_VERBS = new Set([
  "add", "append", "archive", "assign", "cancel", "close", "create", "delete", "destroy", "drop",
  "edit", "execute", "forward", "insert", "invite", "merge", "modify", "move", "patch", "post",
  "publish", "purge", "put", "remove", "rename", "reply", "revoke", "send", "set", "share",
  "submit", "transition", "trash", "unshare", "update", "upload", "upsert", "write",
]);

function nameWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * A human description of what the call may do, or null when it is safe to run unasked.
 * `tool` is undefined when the model called a name the registry does not list: unverified, so ask.
 */
export function describeMcpRisk(tool: McpTool | undefined, calledName = tool?.name ?? ""): string | null {
  if (!tool) return `call an MCP tool REI has no description of (${calledName})`;

  const a = tool.annotations;
  if (a?.readOnlyHint === true) return null;

  if (a?.readOnlyHint === false) {
    // Per the MCP spec destructiveHint defaults to TRUE for a non-read-only tool.
    const effect = a.destructiveHint === false ? "change data" : "delete or overwrite data";
    return a.openWorldHint ? `${effect} outside this machine (send / publish)` : effect;
  }

  const verb = nameWords(tool.name.slice(tool.name.indexOf("/") + 1)).find((w) => MUTATING_VERBS.has(w));
  return verb ? `${verb} something (the server does not declare the tool read-only)` : null;
}

export function confirmMcpEnabled(): boolean {
  return process.env.REI_CONFIRM_MCP !== "false"; // default ON
}

const MAX_ARGS_PREVIEW = 600;

/** The arguments as the user will read them: WHAT would be sent is the whole point of the prompt. */
function argsPreview(args: Record<string, unknown>): string {
  const json = JSON.stringify(args, null, 2) ?? "{}";
  return json.length > MAX_ARGS_PREVIEW ? `${json.slice(0, MAX_ARGS_PREVIEW)}\n    …(truncated)` : json;
}

/**
 * Asks before a side-effecting MCP call. Returns null when the call may proceed, otherwise the tool
 * result to hand back to the model instead of running it.
 */
export async function gateMcpCall(
  qualifiedName: string,
  args: Record<string, unknown>,
  ctx: {
    allMcpTools: McpTool[];
    elicit?: ElicitFn;
    logger: AgentLogger;
    emitStatus: (msg: string) => void;
  },
): Promise<string | null> {
  if (!confirmMcpEnabled()) return null;
  const risk = describeMcpRisk(ctx.allMcpTools.find((t) => t.name === qualifiedName), qualifiedName);
  if (!risk) return null;

  // Nobody to ask is a reason to REFUSE, not to run — same rule as the run_command gates.
  const interactive = !!ctx.elicit;
  const { value } = await (ctx.elicit ?? nonInteractiveElicit)({
    id: newElicitationId(),
    kind: "confirm",
    message: `🔌  The MCP tool ${qualifiedName} may ${risk}, with:\n    ${argsPreview(args)}\nRun it?`,
    default: "no",
  });
  if (value === "yes") return null;

  ctx.logger.logInfo(`[tools] mcp call not run: ${qualifiedName}`, { interactive, risk });
  ctx.emitStatus(
    interactive
      ? `🛑  [REI] MCP call cancelled by the user: ${qualifiedName}`
      : `🛑  [REI] MCP call refused (nobody to confirm with): ${qualifiedName}`,
  );
  // Two different facts, and the model repeats whichever it is told — so it is never told that a
  // user declined when no user was asked.
  return interactive
    ? `The user DECLINED this MCP call (it may ${risk}): ${qualifiedName}\n` +
        `Do NOT call it again. Continue without it, or ask the user how to proceed.`
    : `REFUSED: this MCP call may ${risk} and there is no interactive frontend to confirm with: ` +
        `${qualifiedName}\nDo NOT call it again. Report that it needs a human, or the operator can ` +
        `set REI_CONFIRM_MCP=false to allow it unattended.`;
}
