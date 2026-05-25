import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Shared mock state — created via vi.hoisted so it exists when mock
// factories run (vi.mock factories are hoisted by Vitest).
// ---------------------------------------------------------------------------

const mockState = vi.hoisted(() => ({
  connectCalls: 0,
  closeCalls: 0,
  listToolsResult: { tools: [] as unknown[] },
  callToolResult: { content: [] as unknown[], isError: false as boolean | undefined },
  notificationHandlerCalls: 0,
  resourcesResult: { resources: [] as unknown[] },
  readResourceResult: { contents: [] as unknown[] },
  promptsResult: { prompts: [] as unknown[] },
  getPromptResult: { messages: [] as unknown[] },
}));

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class MockClient {
    connect() {
      mockState.connectCalls++;
      return Promise.resolve();
    }
    close() {
      mockState.closeCalls++;
      return Promise.resolve();
    }
    listTools() {
      return Promise.resolve(mockState.listToolsResult);
    }
    callTool() {
      return Promise.resolve(mockState.callToolResult);
    }
    setNotificationHandler() {
      mockState.notificationHandlerCalls++;
    }
    listResources() {
      return Promise.resolve(mockState.resourcesResult);
    }
    readResource() {
      return Promise.resolve(mockState.readResourceResult);
    }
    listPrompts() {
      return Promise.resolve(mockState.promptsResult);
    }
    getPrompt() {
      return Promise.resolve(mockState.getPromptResult);
    }
  },
}));

vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: class {
    constructor(url: URL, opts?: Record<string, unknown>) {}
    start() {
      return Promise.resolve();
    }
    close() {
      return Promise.resolve();
    }
    send() {
      return Promise.resolve();
    }
  },
}));

vi.mock("@modelcontextprotocol/sdk/types.js", () => ({
  CallToolResultSchema: { parse: (x: unknown) => x as { content: unknown[]; isError?: boolean } },
  LoggingMessageNotificationSchema: {},
  ProgressNotificationSchema: {},
  ResourceListChangedNotificationSchema: {},
  ResourceUpdatedNotificationSchema: {},
  ToolListChangedNotificationSchema: {},
}));

import { HttpMcpClient } from "./http-client.js";
import type { McpTool, McpResource, McpPrompt } from "./mcp-client.js";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("HttpMcpClient", () => {
  beforeEach(() => {
    mockState.connectCalls = 0;
    mockState.closeCalls = 0;
    mockState.listToolsResult = { tools: [] };
    mockState.callToolResult = { content: [], isError: false };
    mockState.notificationHandlerCalls = 0;
    mockState.resourcesResult = { resources: [] };
    mockState.readResourceResult = { contents: [] };
    mockState.promptsResult = { prompts: [] };
    mockState.getPromptResult = { messages: [] };
  });

  describe("create and lifecycle", () => {
    it("creates a client, sets up notification handlers, and connects", async () => {
      const client = await HttpMcpClient.create(
        "test-server",
        "http://localhost:8080/mcp",
      );

      expect(client).toBeInstanceOf(HttpMcpClient);
      expect(mockState.notificationHandlerCalls).toBe(5);
      expect(mockState.connectCalls).toBe(1);
    });

    it("dispose() calls client.close()", async () => {
      const client = await HttpMcpClient.create("svc", "http://localhost/mcp");
      const closesBefore = mockState.closeCalls;

      await client.dispose();

      expect(mockState.closeCalls).toBe(closesBefore + 1);
    });

    it("dispose() is idempotent", async () => {
      const client = await HttpMcpClient.create("svc", "http://localhost/mcp");
      const closesBefore = mockState.closeCalls;

      await client.dispose();
      await client.dispose();

      expect(mockState.closeCalls).toBe(closesBefore + 1);
    });

    it("close() is an alias for dispose()", async () => {
      const client = await HttpMcpClient.create("svc", "http://localhost/mcp");
      const closesBefore = mockState.closeCalls;

      await client.close();

      expect(mockState.closeCalls).toBe(closesBefore + 1);
    });
  });

  describe("listTools()", () => {
    it("prefixes bare tool names with serverName/", async () => {
      mockState.listToolsResult = {
        tools: [
          { name: "readFile", description: "Read a file" },
          { name: "writeFile", description: "Write a file" },
        ],
      };

      const client = await HttpMcpClient.create("fs", "http://localhost/mcp");
      const tools: McpTool[] = await client.listTools();

      expect(tools).toHaveLength(2);
      expect(tools[0].name).toBe("fs/readFile");
      expect(tools[0].description).toBe("Read a file");
      expect(tools[1].name).toBe("fs/writeFile");
    });

    it("uses the tool name as description fallback", async () => {
      mockState.listToolsResult = {
        tools: [{ name: "ping" }],
      };

      const client = await HttpMcpClient.create("svc", "http://localhost/mcp");
      const tools: McpTool[] = await client.listTools();

      expect(tools[0].description).toBe("ping");
    });
  });

  describe("callTool()", () => {
    it("returns concatenated text content", async () => {
      mockState.callToolResult = {
        content: [
          { type: "text", text: "Hello" },
          { type: "text", text: "world" },
        ],
        isError: false,
      };

      const client = await HttpMcpClient.create("svc", "http://localhost/mcp");
      const result = await client.callTool("greet", { name: "world" });

      expect(result).toBe("Hello\nworld");
    });

    it("returns empty string when content is empty", async () => {
      mockState.callToolResult = { content: [], isError: false };

      const client = await HttpMcpClient.create("svc", "http://localhost/mcp");
      const result = await client.callTool("noop", {});

      expect(result).toBe("");
    });

    it("throws when isError=true", async () => {
      mockState.callToolResult = {
        content: [{ type: "text", text: "Permission denied" }],
        isError: true,
      };

      const client = await HttpMcpClient.create("svc", "http://localhost/mcp");
      await expect(client.callTool("restricted", {})).rejects.toThrow(
        "Permission denied",
      );
    });

    it("throws a generic error when isError=true and no text content", async () => {
      mockState.callToolResult = {
        content: [{ type: "image", data: "abc", mimeType: "image/png" }],
        isError: true,
      };

      const client = await HttpMcpClient.create("svc", "http://localhost/mcp");
      await expect(client.callTool("img-only", {})).rejects.toThrow(
        "Unknown MCP tool error",
      );
    });
  });

  describe("listResources()", () => {
    it("returns mapped resources", async () => {
      mockState.resourcesResult = {
        resources: [
          { uri: "file:///tmp/a.txt", name: "a.txt", mimeType: "text/plain" },
          { uri: "file:///tmp/b.txt", name: "b.txt", description: "File B" },
        ],
      };

      const client = await HttpMcpClient.create("svc", "http://localhost/mcp");
      const resources: McpResource[] = await client.listResources();

      expect(resources).toHaveLength(2);
      expect(resources[0].uri).toBe("file:///tmp/a.txt");
      expect(resources[0].mimeType).toBe("text/plain");
      expect(resources[1].description).toBe("File B");
    });
  });

  describe("readResource()", () => {
    it("returns text from contents", async () => {
      mockState.readResourceResult = {
        contents: [
          { type: "text", text: "Hello from resource" },
        ],
      };

      const client = await HttpMcpClient.create("svc", "http://localhost/mcp");
      const result = await client.readResource("file:///tmp/a.txt");

      expect(result).toBe("Hello from resource");
    });

    it("returns empty string when no contents", async () => {
      mockState.readResourceResult = { contents: [] };

      const client = await HttpMcpClient.create("svc", "http://localhost/mcp");
      const result = await client.readResource("file:///tmp/empty.txt");

      expect(result).toBe("");
    });
  });

  describe("listPrompts()", () => {
    it("returns mapped prompts", async () => {
      mockState.promptsResult = {
        prompts: [
          { name: "greet", description: "Greet a user", arguments: [{ name: "name", required: true }] },
          { name: "help" },
        ],
      };

      const client = await HttpMcpClient.create("svc", "http://localhost/mcp");
      const prompts: McpPrompt[] = await client.listPrompts();

      expect(prompts).toHaveLength(2);
      expect(prompts[0].name).toBe("greet");
      expect(prompts[0].arguments).toHaveLength(1);
      expect(prompts[0].arguments![0].required).toBe(true);
      expect(prompts[1].arguments).toBeUndefined();
    });
  });

  describe("getPrompt()", () => {
    it("returns concatenated prompt messages", async () => {
      mockState.getPromptResult = {
        messages: [
          { content: { text: "Hello" } },
          { content: { text: " world" } },
        ],
      };

      const client = await HttpMcpClient.create("svc", "http://localhost/mcp");
      const result = await client.getPrompt("greet", { name: "world" });

      expect(result).toBe("Hello\n world");
    });

    it("returns empty string when no messages", async () => {
      mockState.getPromptResult = { messages: [] };

      const client = await HttpMcpClient.create("svc", "http://localhost/mcp");
      const result = await client.getPrompt("empty");

      expect(result).toBe("");
    });
  });
});