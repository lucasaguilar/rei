/**
 * @fileoverview MCP client for remote servers over Streamable HTTP transport.
 * Communicates via HTTP POST using the official @modelcontextprotocol/sdk.
 *
 * @module rei/tools/mcp/http-client
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import type { McpClient, McpTool, McpResource, McpPrompt } from "./mcp-client.js";
import {
  setupNotificationHandlers,
  extractTextContent,
  extractTextContentFromContents,
  extractPromptMessages,
  getToolCallOptions,
} from "./shared.js";

// ---------------------------------------------------------------------------
// HttpMcpClient
// ---------------------------------------------------------------------------

/**
 * MCP client that communicates with a remote MCP server over HTTP (Streamable
 * HTTP transport) using the official @modelcontextprotocol/sdk.
 *
 * Lifecycle:
 *   1. `HttpMcpClient.create(serverName, url, headers?)` — connects to the
 *      remote server and performs the MCP `initialize` handshake via the SDK.
 *   2. `listTools()` — calls `tools/list` with schema validation.
 *   3. `callTool(name, args)` — calls `tools/call` with schema validation.
 *   4. `dispose()` — cleanly closes the SDK client and transport.
 */
export class HttpMcpClient implements McpClient {
  private readonly client: Client;
  private readonly transport: StreamableHTTPClientTransport;
  private readonly serverName: string;
  private disposed = false;

  private constructor(
    client: Client,
    transport: StreamableHTTPClientTransport,
    serverName: string,
  ) {
    this.client = client;
    this.transport = transport;
    this.serverName = serverName;
  }

  // -------------------------------------------------------------------------
  // Factory — connects and performs the initialize handshake
  // -------------------------------------------------------------------------

  static async create(
    serverName: string,
    url: string,
    headers?: Record<string, string>,
  ): Promise<HttpMcpClient> {
    const transportOpts: Record<string, unknown> = {};

    if (headers && Object.keys(headers).length > 0) {
      transportOpts.requestInit = {
        headers: { ...headers },
      };
    }

    const transport = new StreamableHTTPClientTransport(
      new URL(url),
      transportOpts,
    );

    const client = new Client(
      { name: "rei", version: "0.1.0" },
      {
        capabilities: {},
      },
    );

    // Set up notification handlers before connecting
    setupNotificationHandlers(client, serverName);

    // Connect — this performs the initialize handshake automatically.
    // Streamable HTTP transport uses `start()` then `client.connect(transport)`.
    console.debug(`[MCP/${serverName}] About to call client.connect()`);
    
    // Use Promise.race with timeout to prevent indefinite hang
    // When timeout fires, immediately abort the transport's HTTP request
    const connectPromise = client.connect(transport);
    
    const timeoutPromise = new Promise<never>((_, reject) => {
      const timeoutId = setTimeout(async () => {
        console.error(`[MCP/${serverName}] ⏱️  TIMEOUT: client.connect() did not complete in 15 seconds!`);
        // Immediately close the transport to abort any pending HTTP requests
        try {
          await transport.close();
          console.error(`[MCP/${serverName}] Transport closed due to timeout`);
        } catch (closeErr) {
          console.error(`[MCP/${serverName}] Error closing transport:`, closeErr);
        }
        reject(new Error(`Connection timeout for ${serverName}`));
      }, 15000);
      
      // Clean up timeout if connection succeeds
      connectPromise.finally(() => clearTimeout(timeoutId));
    });

    try {
      await Promise.race([connectPromise, timeoutPromise]);
      console.debug(`[MCP/${serverName}] ✅ client.connect() completed successfully`);
    } catch (err) {
      console.error(`[MCP/${serverName}] ❌ client.connect() failed:`, err);
      try {
        await transport.close();
      } catch {
        // ignore
      }
      throw err;
    }

    return new HttpMcpClient(client, transport, serverName);
  }

  // -------------------------------------------------------------------------
  // McpClient interface
  // -------------------------------------------------------------------------

  async listTools(): Promise<McpTool[]> {
    const result = await this.client.listTools();

    return (result.tools ?? []).map((t) => ({
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
      const errorText = extractTextContent(result as { content?: Array<{ type: string; text?: string }> });
      throw new Error(errorText || "Unknown MCP tool error");
    }

    return extractTextContent(result as { content?: Array<{ type: string; text?: string }> });
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
    return extractTextContentFromContents(result as { contents?: Array<{ type?: string; text?: string }> });
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

  async getPrompt(name: string, args?: Record<string, string>): Promise<string> {
    const result = await this.client.getPrompt({ name, arguments: args });
    return extractPromptMessages(result as { messages?: Array<{ content?: { text?: string } }> });
  }
}