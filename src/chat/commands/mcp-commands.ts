import type {
  CommandContext,
  CommandHandler,
  CommandResult,
} from "./command-handler.js";
import type { McpRegistry } from "../../tools/mcp/mcp-registry.js";

/**
 * `/mcp` — enable/disable MCP servers live within the running session (Phase 1).
 *
 *   /mcp                list servers + state
 *   /mcp list           (same)
 *   /mcp on  <name>     connect a server now (tools available next turn)
 *   /mcp off <name>     disconnect a server now
 *   /mcp on             connect ALL declared servers
 *   /mcp off            disconnect ALL connected servers
 *
 * Toggles are session-scoped: a restart returns to whatever `enabled` says in rei.config.json.
 * See docs/sub-agent / rei-config; the registry does the live connect/disconnect.
 */

const USAGE =
  "[REI] Usage:\n" +
  "  /mcp                list MCP servers + state\n" +
  "  /mcp on <name>      connect a server (tools available next turn)\n" +
  "  /mcp off <name>     disconnect a server\n" +
  "  /mcp on | off       all servers";

/** Control command — don't clutter the conversation history with it. */
function reply(response: string): CommandResult {
  return { success: true, response, recordInSession: false };
}

function renderList(registry: McpRegistry): string {
  const servers = registry.listServers();
  if (servers.length === 0) {
    return "[REI] No MCP servers declared in rei.config.json.";
  }
  const rows = servers.map((s) => {
    const state = s.connected
      ? `🟢 on   ${s.tools} tool${s.tools === 1 ? "" : "s"}`
      : "⚪ off";
    const cfg = s.enabledInConfig ? "" : "  (enabled:false)";
    return `  ${s.name.padEnd(18)} ${s.transport.padEnd(6)} ${state}${cfg}`;
  });
  return (
    `[REI] MCP servers:\n${rows.join("\n")}\n\n` +
    "Toggle:  /mcp on <name>  ·  /mcp off <name>  ·  /mcp on|off (all)"
  );
}

async function toggleOne(
  registry: McpRegistry,
  name: string,
  enable: boolean,
): Promise<string> {
  try {
    if (enable) {
      const { tools } = await registry.connectServer(name);
      return `[REI] ✅ '${name}' connected (${tools} tool${tools === 1 ? "" : "s"}). Available next turn.`;
    }
    const was = await registry.disconnectServer(name);
    return was
      ? `[REI] '${name}' disconnected. Its tools are gone next turn.`
      : `[REI] '${name}' was not connected.`;
  } catch (err) {
    return `[REI] ❌ ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function toggleAll(
  registry: McpRegistry,
  enable: boolean,
): Promise<string> {
  const servers = registry.listServers();
  if (servers.length === 0) {
    return "[REI] No MCP servers declared in rei.config.json.";
  }
  const results: string[] = [];
  for (const s of servers) {
    try {
      if (enable) {
        const { tools } = await registry.connectServer(s.name);
        results.push(`✅ ${s.name} (${tools})`);
      } else {
        await registry.disconnectServer(s.name);
        results.push(`⚪ ${s.name}`);
      }
    } catch (err) {
      results.push(
        `❌ ${s.name}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return `[REI] MCP ${enable ? "connect" : "disconnect"} all:\n  ${results.join("\n  ")}`;
}

export const mcpCommands: CommandHandler = {
  match(command: string): boolean {
    return command === "/mcp" || command.startsWith("/mcp ");
  },

  async run(ctx: CommandContext): Promise<CommandResult> {
    const registry = ctx.mcpRegistry;
    if (!registry) {
      return reply("[REI] MCP registry is not available in this context.");
    }

    const parts = ctx.command.trim().split(/\s+/).slice(1); // drop "/mcp"
    const sub = (parts[0] ?? "list").toLowerCase();
    const target = parts[1];

    if (sub === "list") return reply(renderList(registry));

    if (sub === "on" || sub === "off") {
      const enable = sub === "on";
      return reply(
        target
          ? await toggleOne(registry, target, enable)
          : await toggleAll(registry, enable),
      );
    }

    return reply(USAGE);
  },
};
