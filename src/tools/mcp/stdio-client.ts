/**
 * @fileoverview MCP client for local server processes over stdio transport.
 * Spawns a child process and communicates via stdin/stdout using the official
 * @modelcontextprotocol/sdk.
 *
 * @module rei/tools/mcp/stdio-client
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import type {
  McpClient,
  McpTool,
  McpResource,
  McpPrompt,
} from "./mcp-client.js";
import {
  setupNotificationHandlers,
  extractTextContent,
  extractTextContentFromContents,
  extractPromptMessages,
  getToolCallOptions,
} from "./shared.js";

// ---------------------------------------------------------------------------
// StdioMcpClient
// ---------------------------------------------------------------------------

/**
 * MCP client that communicates with a local server process over stdio using
 * the official @modelcontextprotocol/sdk.
 *
 * Lifecycle:
 *   1. `StdioMcpClient.create(serverName, command, args, env)` — spawns the
 *      process and performs the MCP `initialize` handshake via the SDK.
 *   2. `listTools()` — calls `tools/list` with schema validation.
 *   3. `callTool(name, args)` — calls `tools/call` with schema validation.
 *   4. `dispose()` — cleanly closes the SDK client and transport.
 */
export class StdioMcpClient implements McpClient {
  private readonly client: Client;
  private readonly transport: StdioClientTransport;
  private readonly serverName: string;
  private disposed = false;

  private constructor(
    client: Client,
    transport: StdioClientTransport,
    serverName: string,
  ) {
    this.client = client;
    this.transport = transport;
    this.serverName = serverName;
  }

  // -------------------------------------------------------------------------
  // Factory — spawns the process and performs the initialize handshake
  // -------------------------------------------------------------------------

  static async create(
    serverName: string,
    command: string,
    args: string[] = [],
    env?: Record<string, string>,
  ): Promise<StdioMcpClient> {
    const transport = new StdioClientTransport({
      command,
      args,
      env,
      stderr: "pipe",
    });

    const client = new Client(
      { name: "rei", version: "0.1.0" },
      {
        capabilities: {},
      },
    );

    // Set up notification handlers before connecting
    setupNotificationHandlers(client, serverName);

    // Connect — this performs the initialize handshake automatically.
    // Stdio transport uses spawn then `client.connect(transport)`.
    await client.connect(transport);

    return new StdioMcpClient(client, transport, serverName);
  }

  // -------------------------------------------------------------------------
  // McpClient interface
  // -------------------------------------------------------------------------

  async listTools(): Promise<McpTool[]> {
    const result = await this.client.listTools();

    return (result.tools ?? []).map((t) => ({
      // Prefix with serverName so names are globally unique across registries
      name: `${this.serverName}/${t.name}`,
      description: t.description ?? t.name,
      inputSchema: t.inputSchema as Record<string, unknown> | undefined,
    }));
  }

  async callTool(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    const result = await this.client.callTool(
      { name: toolName, arguments: args },
      CallToolResultSchema,
      getToolCallOptions(),
    );

    if (result.isError) {
      const errorText = extractTextContent(
        result as { content?: Array<{ type: string; text?: string }> },
      );
      throw new Error(errorText || "Unknown MCP tool error");
    }

    return extractTextContent(
      result as { content?: Array<{ type: string; text?: string }> },
    );
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;

    try {
      await this.client.close();
    } catch {
      // best-effort — transport cleanup is handled by SDK
    }
  }

  /** Alias for dispose() — satisfies SDK convention. */
  async close(): Promise<void> {
    return this.dispose();
  }

  // -------------------------------------------------------------------------
  // Resources
  // -------------------------------------------------------------------------

  async listResources(): Promise<McpResource[]> {
    const result = await this.client.listResources();
    return (result.resources ?? []).map((r) => ({
      uri: r.uri,
      name: r.name,
      description: r.description,
      mimeType: r.mimeType,
    }));
  }

  async readResource(uri: string): Promise<string> {
    const result = await this.client.readResource({ uri });
    return extractTextContentFromContents(
      result as { contents?: Array<{ type?: string; text?: string }> },
    );
  }

  // -------------------------------------------------------------------------
  // Prompts
  // -------------------------------------------------------------------------

  async listPrompts(): Promise<McpPrompt[]> {
    const result = await this.client.listPrompts();
    return (result.prompts ?? []).map((p) => ({
      name: p.name,
      description: p.description,
      arguments: p.arguments?.map((a) => ({
        name: a.name,
        description: a.description,
        required: a.required,
      })),
    }));
  }

  async getPrompt(
    name: string,
    args?: Record<string, string>,
  ): Promise<string> {
    const result = await this.client.getPrompt({ name, arguments: args });
    return extractPromptMessages(
      result as { messages?: Array<{ content?: { text?: string } }> },
    );
  }
}
