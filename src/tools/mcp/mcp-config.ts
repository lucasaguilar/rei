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
export type McpConnectionConfig =
  | {
      type: "stdio";
      command: string;
      args?: string[];
      env?: Record<string, string>;
    }
  | {
      type: "http";
      url: string;
      headers?: Record<string, string>;
    };

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
  const candidates = [
    path.join(workspacePath, CONFIG_FILENAME),
    path.join(process.cwd(), CONFIG_FILENAME),
  ];

  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    try {
      const raw = fs.readFileSync(candidate, "utf-8");
      return JSON.parse(raw) as ReiConfig;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[REI/MCP] Could not parse ${candidate}: ${msg} — skipping.`,
      );
    }
  }

  return {};
}
