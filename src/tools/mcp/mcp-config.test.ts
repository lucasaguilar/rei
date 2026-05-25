import { describe, it, expect, vi, afterEach } from "vitest";
import { loadReiConfig } from "./mcp-config.js";

// In ESM, vi.spyOn on native modules doesn't work — use vi.mock instead.
vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}));

import * as fs from "node:fs";

describe("loadReiConfig", () => {
  afterEach(() => {
    vi.resetAllMocks();
  });

  it("returns an empty object when no config file exists", () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    expect(loadReiConfig("/any/workspace")).toEqual({});
  });

  it("parses a valid config with mcpServers", () => {
    const config = {
      mcpServers: {
        filesystem: {
          type: "stdio",
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
          env: { MY_VAR: "hello" },
        },
      },
    };

    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(config));

    const result = loadReiConfig("/workspace");
    expect(result.mcpServers?.["filesystem"]).toMatchObject({
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
      env: { MY_VAR: "hello" },
    });
  });

  it("returns an empty object and warns when the file is malformed JSON", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue("{ not valid json }");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = loadReiConfig("/workspace");

    expect(result).toEqual({});
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Could not parse"),
    );
  });

  it("returns an empty object when mcpServers key is absent", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({}));

    const result = loadReiConfig("/workspace");
    expect(result.mcpServers).toBeUndefined();
  });

  it("parses a config with http transport", () => {
    const config = {
      mcpServers: {
        remote: {
          type: "http",
          url: "http://localhost:8080/mcp",
          headers: { Authorization: "Bearer token123" },
        },
      },
    };

    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(config));

    const result = loadReiConfig("/workspace");
    const entry = result.mcpServers?.["remote"];
    expect(entry).toBeDefined();

    if (entry && "type" in entry && entry.type === "http") {
      expect(entry.url).toBe("http://localhost:8080/mcp");
      expect(entry.headers?.Authorization).toBe("Bearer token123");
    } else {
      expect(entry).toHaveProperty("type", "http");
    }
  });
});
