import { describe, it, expect, vi, beforeEach } from "vitest";
import { McpRegistry } from "./mcp-registry.js";
import * as mcpConfig from "./mcp-config.js";
import { StdioMcpClient } from "./stdio-client.js";

// Prevent real network calls in HTTP-server tests. The SDK's
// StreamableHTTPClientTransport fires a background fetch even after the
// connect() promise rejects, producing an unhandled rejection that fails the
// test suite. By stubbing create() to reject synchronously we keep the test
// intent (registry swallows connection failures) without touching the network.
vi.mock("./http-client.js", () => ({
  HttpMcpClient: {
    create: vi.fn().mockRejectedValue(new Error("connection refused")),
  },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFakeClient(
  serverName: string,
  tools: Array<{ name: string; description: string }>,
) {
  return {
    listTools: vi.fn().mockResolvedValue(
      tools.map((t) => ({
        name: `${serverName}/${t.name}`,
        description: t.description,
      })),
    ),
    callTool: vi.fn().mockResolvedValue("tool result"),
    dispose: vi.fn().mockResolvedValue(undefined),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("McpRegistry", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe("connect()", () => {
    it("is a no-op when no servers are configured", async () => {
      vi.spyOn(mcpConfig, "loadReiConfig").mockReturnValue({ mcpServers: {} });

      const registry = McpRegistry.forWorkspace("/workspace");
      await registry.connect();

      expect(registry.getAvailableTools()).toEqual([]);
      expect(registry.hasTools()).toBe(false);
    });

    it("is idempotent — second call is a no-op", async () => {
      const spy = vi
        .spyOn(mcpConfig, "loadReiConfig")
        .mockReturnValue({ mcpServers: {} });

      const registry = McpRegistry.forWorkspace("/workspace");
      await registry.connect();
      await registry.connect();

      expect(spy).toHaveBeenCalledTimes(1);
    });

    it("skips a server that fails to connect and continues", async () => {
      vi.spyOn(mcpConfig, "loadReiConfig").mockReturnValue({
        mcpServers: {
          broken: { type: "stdio", command: "does-not-exist" },
        },
      });

      // StdioMcpClient.create will throw because the binary doesn't exist —
      // the registry should swallow it and leave tools empty.
      const registry = McpRegistry.forWorkspace("/workspace");
      await registry.connect(); // must not throw

      expect(registry.getAvailableTools()).toEqual([]);
    });

    it("skips an HTTP server that fails to connect and continues", async () => {
      vi.spyOn(mcpConfig, "loadReiConfig").mockReturnValue({
        mcpServers: {
          remote: {
            type: "http",
            url: "http://localhost:1",
          },
        },
      });

      // HttpMcpClient.create will throw because nothing listens on port 1 —
      // the registry should swallow it and leave tools empty.
      const registry = McpRegistry.forWorkspace("/workspace");
      await registry.connect(); // must not throw

      expect(registry.getAvailableTools()).toEqual([]);
    });

    it("interpolates environment variables, args and headers with process.env values", async () => {
      const createSpy = vi.spyOn(StdioMcpClient, "create").mockResolvedValue({
        listTools: vi.fn().mockResolvedValue([]),
        callTool: vi.fn(),
        dispose: vi.fn(),
      } as any);

      process.env.TEST_VAR_1 = "test-val-1";
      process.env.TEST_VAR_2 = "test-val-2";

      vi.spyOn(mcpConfig, "loadReiConfig").mockReturnValue({
        mcpServers: {
          testServer: {
            type: "stdio",
            command: "test-cmd",
            args: ["--arg=${TEST_VAR_1}"],
            env: {
              VAR: "${TEST_VAR_2}",
            },
          },
        },
      });

      const registry = McpRegistry.forWorkspace("/workspace");
      await registry.connect();

      expect(createSpy).toHaveBeenCalledWith(
        "testServer",
        "test-cmd",
        ["--arg=test-val-1"],
        { VAR: "test-val-2" },
      );

      delete process.env.TEST_VAR_1;
      delete process.env.TEST_VAR_2;
    });
  });

  describe("getAvailableTools()", () => {
    it("aggregates tools from all connected servers", async () => {
      // Bypass StdioMcpClient by injecting servers directly via the private
      // field — we test the public surface only, so we use a cast.
      const registry = McpRegistry.forWorkspace("/workspace") as unknown as {
        servers: Map<string, { client: unknown; tools: unknown[] }>;
        connected: boolean;
      };
      registry.connected = true;
      registry.servers.set("alpha", {
        client: makeFakeClient("alpha", []),
        tools: [{ name: "alpha/ping", description: "Ping alpha" }],
      });
      registry.servers.set("beta", {
        client: makeFakeClient("beta", []),
        tools: [{ name: "beta/echo", description: "Echo beta" }],
      });

      const tools = (registry as unknown as McpRegistry).getAvailableTools();
      expect(tools).toHaveLength(2);
      expect(tools.map((t) => t.name)).toEqual(["alpha/ping", "beta/echo"]);
    });
  });

  describe("dispatch()", () => {
    it("routes a qualified call to the correct server", async () => {
      const fakeClient = makeFakeClient("fs", [
        { name: "readFile", description: "Read a file" },
      ]);

      const registry = McpRegistry.forWorkspace("/workspace") as unknown as {
        servers: Map<string, { client: typeof fakeClient; tools: unknown[] }>;
        connected: boolean;
      };
      registry.connected = true;
      registry.servers.set("fs", {
        client: fakeClient,
        tools: [{ name: "fs/readFile", description: "Read a file" }],
      });

      const result = await (registry as unknown as McpRegistry).dispatch(
        "fs/readFile",
        { path: "src/main.ts" },
      );

      expect(fakeClient.callTool).toHaveBeenCalledWith("readFile", {
        path: "src/main.ts",
      });
      expect(result).toBe("tool result");
    });

    it("throws when the tool name has no slash", async () => {
      const registry = McpRegistry.forWorkspace("/workspace");
      await expect(
        registry.dispatch("noSlashHere", {}),
      ).rejects.toThrow('must be qualified as "serverName/toolName"');
    });

    it("throws when the server name is not connected", async () => {
      const registry = McpRegistry.forWorkspace("/workspace");
      await expect(
        registry.dispatch("unknown/tool", {}),
      ).rejects.toThrow('No connected MCP server named "unknown"');
    });

    it("propagates errors thrown by the underlying client", async () => {
      const fakeClient = makeFakeClient("svc", []);
      fakeClient.callTool.mockRejectedValue(new Error("server error"));

      const registry = McpRegistry.forWorkspace("/workspace") as unknown as {
        servers: Map<string, { client: typeof fakeClient; tools: unknown[] }>;
        connected: boolean;
      };
      registry.connected = true;
      registry.servers.set("svc", { client: fakeClient, tools: [] });

      await expect(
        (registry as unknown as McpRegistry).dispatch("svc/tool", {}),
      ).rejects.toThrow("server error");
    });
  });

  describe("dispose()", () => {
    it("calls dispose on every connected client and clears servers", async () => {
      const clientA = makeFakeClient("a", []);
      const clientB = makeFakeClient("b", []);

      const registry = McpRegistry.forWorkspace("/workspace") as unknown as {
        servers: Map<
          string,
          { client: typeof clientA; tools: unknown[] }
        >;
        connected: boolean;
      };
      registry.connected = true;
      registry.servers.set("a", { client: clientA, tools: [] });
      registry.servers.set("b", { client: clientB, tools: [] });

      await (registry as unknown as McpRegistry).dispose();

      expect(clientA.dispose).toHaveBeenCalledOnce();
      expect(clientB.dispose).toHaveBeenCalledOnce();
      expect(registry.servers.size).toBe(0);
    });
  });
});
