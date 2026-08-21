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
/** One row of `/mcp list`: a configured server and its live state. */
export interface McpServerStatus {
  name: string;
  transport: McpConnectionConfig["type"];
  /** Auto-connect flag from rei.config.json (enabled !== false). */
  enabledInConfig: boolean;
  /** Currently connected in THIS session (reflects runtime /mcp on|off toggles). */
  connected: boolean;
  /** Tool count when connected, else 0. */
  tools: number;
}

export class McpRegistry {
  private readonly workspacePath: string;
  private servers = new Map<string, ConnectedServer>();
  /** All servers declared in rei.config.json (connected or not) — the source for /mcp list + toggles. */
  private configEntries = new Map<string, McpConnectionConfig>();
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
  /** (Re)reads rei.config.json into `configEntries` — the full set of declared servers. */
  private loadConfigEntries(): void {
    const config = loadReiConfig(this.workspacePath);
    this.configEntries = new Map(Object.entries(config.mcpServers ?? {}));
  }

  async connect(): Promise<void> {
    if (this.connected) return;

    // Idempotency lives in the flag, not in the config: mark connected BEFORE any early
    // return so a second connect() is a true no-op (the docstring promises it).
    this.connected = true;

    this.loadConfigEntries();

    // Only auto-connect servers that aren't explicitly disabled. The rest stay declared but off,
    // ready to be toggled live with `/mcp on <name>`.
    const toConnect = Array.from(this.configEntries.entries()).filter(
      ([, cfg]) => cfg.enabled !== false,
    );
    if (toConnect.length === 0) return;

    await Promise.all(
      toConnect.map(async ([serverName]) => {
        try {
          await this.connectServer(serverName);
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
      `[MCP Registry] 🔌 Connected ${this.servers.size}/${toConnect.length} server(s)${summaries ? `: ${summaries}` : ""}`,
    );
  }

  // -------------------------------------------------------------------------
  // Runtime enable/disable (session-scoped — /mcp command). See mcp-commands.ts.
  // -------------------------------------------------------------------------

  /**
   * Connects a single declared server on demand and lists its tools. Idempotent (a no-op if already
   * connected). Its tools become available on the NEXT turn (the agent reads getAvailableTools() live).
   * @throws if `name` isn't declared in rei.config.json, or the connection/handshake fails.
   */
  async connectServer(name: string): Promise<{ tools: number }> {
    const existing = this.servers.get(name);
    if (existing) return { tools: existing.tools.length };

    if (this.configEntries.size === 0) this.loadConfigEntries();
    const config = this.configEntries.get(name);
    if (!config) {
      const known = Array.from(this.configEntries.keys()).join(", ") || "none";
      throw new Error(
        `No MCP server named "${name}" in rei.config.json. Declared: ${known}.`,
      );
    }

    const client = await this.createClient(name, config);
    const tools = await client.listTools();
    this.servers.set(name, { client, tools });
    return { tools: tools.length };
  }

  /** Disconnects a single server (disposes its transport). Returns false if it wasn't connected. */
  async disconnectServer(name: string): Promise<boolean> {
    const entry = this.servers.get(name);
    if (!entry) return false;
    await entry.client.dispose();
    this.servers.delete(name);
    return true;
  }

  /** Every declared server + its live state (for `/mcp list`). */
  listServers(): McpServerStatus[] {
    if (this.configEntries.size === 0) this.loadConfigEntries();
    return Array.from(this.configEntries.entries()).map(([name, cfg]) => {
      const conn = this.servers.get(name);
      return {
        name,
        transport: cfg.type,
        enabledInConfig: cfg.enabled !== false,
        connected: !!conn,
        tools: conn ? conn.tools.length : 0,
      };
    });
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
