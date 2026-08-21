/**
 * @fileoverview Configuration loader for MCP server definitions.
 * Reads `rei.config.json` from the workspace and returns typed config objects
 * that drive which MCP servers to spawn on session start.
 *
 * @module rei/tools/mcp/mcp-config
 */

import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Shape of one entry inside the `mcpServers` map in `rei.config.json`.
 *
 * Example rei.config.json:
 * ```json
 * {
 *   "mcpServers": {
 *     "filesystem": {
 *       "type": "stdio",
 *       "command": "npx",
 *       "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
 *       "env": { "MY_VAR": "value" }
 *     },
 *     "remote": {
 *       "type": "http",
 *       "url": "http://localhost:8080/mcp",
 *       "headers": { "Authorization": "Bearer token123" }
 *     }
 *   }
 * }
 * ```
 */
/** Common fields shared by every transport. `enabled: false` defines a server without
 *  auto-connecting it at startup — toggle it live with `/mcp on <name>`. Omitted = enabled. */
interface McpCommonConfig {
  /** Auto-connect at startup. Defaults to true when omitted. */
  enabled?: boolean;
}

export type McpConnectionConfig =
  | (McpCommonConfig & {
      type: "stdio";
      command: string;
      args?: string[];
      env?: Record<string, string>;
    })
  | (McpCommonConfig & {
      type: "http";
      url: string;
      headers?: Record<string, string>;
    });

export interface ReiConfig {
  mcpServers?: Record<string, McpConnectionConfig>;
}

const CONFIG_FILENAME = "rei.config.json";

/**
 * Reads `rei.config.json` from the workspace root (or REI's own root as
 * fallback).  Returns an empty object when the file does not exist or cannot
 * be parsed.
 */
export function loadReiConfig(workspacePath: string): ReiConfig {
  // Try the workspace config first, then REI's cwd as a global fallback.
  // De-duplicated so the same path isn't parsed (and warned about) twice when
  // the workspace IS the cwd.
  const candidates = [...new Set([
    path.join(workspacePath, CONFIG_FILENAME),
    path.join(process.cwd(), CONFIG_FILENAME),
  ])];

  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;

    // The FIRST existing config file is authoritative — its presence is an
    // explicit "this is my config". So we never fall through to a later candidate
    // (e.g. the global one) just because this file is empty or malformed. An empty
    // `{}` or `{"mcpServers": {}}` therefore means "no MCP servers here".
    try {
      const raw = fs.readFileSync(candidate, "utf-8").trim();
      if (!raw) return {}; // empty file → explicit "no servers", no global fallback
      return JSON.parse(raw) as ReiConfig;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[REI/MCP] Could not parse ${candidate}: ${msg} — treating as no MCP servers.`,
      );
      return {}; // malformed but present → no servers, do NOT use the global fallback
    }
  }

  return {};
}
