/**
 * @fileoverview Core type definitions for the Model Context Protocol (MCP)
 * integration. These types form the contract that every transport adapter
 * (stdio, HTTP, etc.) must satisfy.
 *
 * @module rei/tools/mcp/mcp-client
 */

/**
 * Represents a single tool advertised by an MCP server.
 */
export interface McpTool {
  /** Globally unique name used in <call_tool> tags: "serverName/toolName" */
  readonly name: string;
  /** Short human-readable description surfaced to the model. */
  readonly description: string;
  /** JSON Schema object describing the input parameters (optional). */
  readonly inputSchema?: Record<string, unknown>;
  /** The server's own declaration of what the tool does to the world. Kept because it is the only
   *  signal, short of guessing from the name, for whether a call needs the user's confirm. */
  readonly annotations?: McpToolAnnotations;
}

/**
 * Behaviour hints from the MCP spec (`Tool.annotations`). They are HINTS: a server can omit or
 * misstate them, so the gate treats a missing hint as unknown, never as "safe".
 */
export interface McpToolAnnotations {
  readonly title?: string;
  /** True: the tool does not modify its environment. */
  readonly readOnlyHint?: boolean;
  /** Only meaningful when not read-only. True (the spec default): may delete or overwrite. */
  readonly destructiveHint?: boolean;
  /** Calling it again with the same arguments has no further effect. */
  readonly idempotentHint?: boolean;
  /** Reaches outside a closed domain — sends mail, posts, hits the public web. */
  readonly openWorldHint?: boolean;
}

/**
 * Represents a resource exposed by an MCP server.
 */
export interface McpResource {
  readonly uri: string;
  readonly name: string;
  readonly description?: string;
  readonly mimeType?: string;
}

/**
 * Represents a prompt template exposed by an MCP server.
 */
export interface McpPrompt {
  readonly name: string;
  readonly description?: string;
  readonly arguments?: Array<{
    name: string;
    description?: string;
    required?: boolean;
  }>;
}

/**
 * Minimal contract every MCP transport adapter must satisfy.
 * Concrete implementations live alongside this file (e.g. stdio, SSE, HTTP).
 */
export interface McpClient {
  /** Return the tools this server currently exposes. */
  listTools(): Promise<McpTool[]>;

  /**
   * Invoke a tool and return its text output.
   *
   * @param toolName  - The bare tool name as returned by `listTools` (without
   *                    the "serverName/" prefix).
   * @param args      - Arbitrary JSON-serialisable arguments.
   */
  callTool(toolName: string, args: Record<string, unknown>): Promise<string>;

  /** Return the resources this server exposes. */
  listResources(): Promise<McpResource[]>;

  /** Read the content of a resource by URI. */
  readResource(uri: string): Promise<string>;

  /** Return the prompt templates this server offers. */
  listPrompts(): Promise<McpPrompt[]>;

  /** Get a prompt by name with optional arguments. */
  getPrompt(name: string, args?: Record<string, unknown>): Promise<string>;

  /** Release any underlying resources (child process, socket, …). */
  dispose(): Promise<void>;

  /** Alias for dispose() — satisfies SDK convention. */
  close(): Promise<void>;
}
