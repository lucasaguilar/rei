/**
 * @fileoverview Central registry that manages MCP server connections and
 * provides tool dispatch for the REI agent. Reads server definitions from
 * `rei.config.json`, spawns transport clients, and aggregates available tools.
 *
 * @module rei/tools/mcp/mcp-registry
 */

import type { McpClient, McpTool } from "./mcp-client.js";
import { StdioMcpClient } from "./stdio-client.js";
import { HttpMcpClient } from "./http-client.js";
import { loadReiConfig, type McpConnectionConfig } from "./mcp-config.js";
import { withToolSpan } from "../../telemetry/spans.js";

interface ConnectedServer {
  client: McpClient;
  tools: McpTool[];
}

/**
 * Manages the lifecycle of all configured MCP server connections and acts as
 * the single dispatch point for tool calls inside REI.
 *
 * Usage:
 *   const registry = McpRegistry.forWorkspace(workspacePath);
 *   await registry.connect();                     // one-time init
 *   const tools = registry.getAvailableTools();   // passed to TurnContext
 *   const result = await registry.dispatch("filesystem/readFile", { path: "…" });
 */
export class McpRegistry {
  private readonly workspacePath: string;
  private servers = new Map<string, ConnectedServer>();
  private connected = false;

  private constructor(workspacePath: string) {
    this.workspacePath = workspacePath;
  }

  // -------------------------------------------------------------------------
  // Factory
  // -------------------------------------------------------------------------

  static forWorkspace(workspacePath: string): McpRegistry {
    return new McpRegistry(workspacePath);
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Creates the appropriate transport-specific client from a config entry.
   */
  private async createClient(
    serverName: string,
    config: McpConnectionConfig,
  ): Promise<McpClient> {
    if (config.type === "http") {
      const headers: Record<string, string> = {};
      if (config.headers) {
        for (const [key, value] of Object.entries(config.headers)) {
          headers[key] = value.replace(/\${([^}]+)}/g, (_, name) => process.env[name] ?? "");
        }
      }
      return HttpMcpClient.create(serverName, config.url, headers);
    }

    const env: Record<string, string> = {};
    if (config.env) {
      for (const [key, value] of Object.entries(config.env)) {
        env[key] = value.replace(/\${([^}]+)}/g, (_, name) => process.env[name] ?? "");
      }
    }

    const args = (config.args ?? []).map((arg) =>
      arg.replace(/\${([^}]+)}/g, (_, name) => process.env[name] ?? ""),
    );

    return StdioMcpClient.create(
      serverName,
      config.command,
      args,
      env,
    );
  }

  /**
   * Reads `rei.config.json`, spawns each configured MCP server and performs
   * the MCP initialize handshake.  Servers that fail to connect are skipped
   * with a warning rather than aborting startup.
   *
   * Safe to call multiple times — subsequent calls are no-ops.
   */
  async connect(): Promise<void> {
    if (this.connected) return;
    this.connected = true;

    const config = loadReiConfig(this.workspacePath);
    const entries = Object.entries(config.mcpServers ?? {});

    if (entries.length === 0) return;

    await Promise.all(
      entries.map(async ([serverName, serverConfig]) => {
        try {
          const client = await this.createClient(serverName, serverConfig);
          const tools = await client.listTools();
          this.servers.set(serverName, { client, tools });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(
            `[MCP Registry] ❌ Failed to connect to MCP server "${serverName}": ${msg}`,
          );
        }
      }),
    );

    const summaries = Array.from(this.servers.entries())
      .map(([name, s]) => `${name} (${s.tools.length} tools)`)
      .join(", ");

    console.log(
      `[MCP Registry] 🔌 Connected ${this.servers.size}/${entries.length} server(s)${summaries ? `: ${summaries}` : ""}`,
    );
  }

  /**
   * Cleanly shuts down all MCP server connections.  Called on process exit or
   * session end.
   */
  async dispose(): Promise<void> {
    await Promise.all(
      Array.from(this.servers.values()).map((s) => s.client.dispose()),
    );
    this.servers.clear();
    this.connected = false;
  }

  // -------------------------------------------------------------------------
  // Tool access
  // -------------------------------------------------------------------------

  /**
   * Returns a flat list of all tools across every connected server.
   * Names are already prefixed with "serverName/" by the client.
   */
  getAvailableTools(): McpTool[] {
    return Array.from(this.servers.values()).flatMap((s) => s.tools);
  }

  /** `true` when at least one server is connected and has tools. */
  hasTools(): boolean {
    return this.getAvailableTools().length > 0;
  }

  // -------------------------------------------------------------------------
  // Dispatch
  // -------------------------------------------------------------------------

  /**
   * Executes a tool call addressed as "serverName/toolName".
   *
   * @throws if the prefix does not match a connected server or the server
   *         returns an error.
   */
  async dispatch(
    qualifiedName: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    // `tool.mcp.<server>/<tool>` span (Laminar `spanType: "TOOL"`) — single chokepoint for
    // every MCP call, from both the native and XML dispatch paths. No-op without telemetry.
    return withToolSpan(`mcp.${qualifiedName}`, args, () =>
      this.dispatchImpl(qualifiedName, args),
    );
  }

  private async dispatchImpl(
    qualifiedName: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    const slashIndex = qualifiedName.indexOf("/");
    if (slashIndex === -1) {
      throw new Error(
        `MCP tool name "${qualifiedName}" must be qualified as "serverName/toolName".`,
      );
    }

    const serverName = qualifiedName.slice(0, slashIndex);
    const toolName = qualifiedName.slice(slashIndex + 1);

    const entry = this.servers.get(serverName);
    if (!entry) {
      throw new Error(
        `No connected MCP server named "${serverName}". ` +
          `Available servers: ${Array.from(this.servers.keys()).join(", ") || "none"}.`,
      );
    }

    return entry.client.callTool(toolName, args);
  }
}
