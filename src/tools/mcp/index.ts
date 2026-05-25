/**
 * @fileoverview Barrel entry point for the MCP module.
 * Re-exports all public symbols for convenient imports from outside the package.
 *
 * @module rei/tools/mcp
 */

export type { McpClient, McpTool, McpResource, McpPrompt } from "./mcp-client.js";
export type { McpConnectionConfig, ReiConfig } from "./mcp-config.js";
export { loadReiConfig } from "./mcp-config.js";
export { StdioMcpClient } from "./stdio-client.js";
export { HttpMcpClient } from "./http-client.js";
export { McpRegistry } from "./mcp-registry.js";
