import { describe, it, expect } from "vitest";
import { mcpTransportOf, type McpConnectionConfig } from "./mcp-config.js";
import { dispatchCommand } from "../../chat/commands/registry.js";
import type { CommandContext } from "../../chat/commands/command-handler.js";

/**
 * `type` is optional in real configs (Claude-Desktop style declares only `command`/`url`), so the
 * SHAPE is the discriminant. Before this, `listServers()` returned `transport: undefined` and
 * `/mcp` threw a TypeError on `.padEnd` that escaped the dispatcher and killed the whole CLI.
 */
describe("mcpTransportOf", () => {
  const cases: [string, McpConnectionConfig, "stdio" | "http"][] = [
    ["explicit stdio", { type: "stdio", command: "x" }, "stdio"],
    ["explicit http", { type: "http", url: "http://h/mcp" }, "http"],
    ["sse counts as http", { type: "sse", url: "http://h/sse" }, "http"],
    ["no type + command -> stdio", { command: "/usr/bin/thing", args: ["mcp"] } as McpConnectionConfig, "stdio"],
    ["no type + url -> http", { url: "http://h/mcp" } as McpConnectionConfig, "http"],
  ];
  for (const [name, cfg, expected] of cases) {
    it(name, () => expect(mcpTransportOf(cfg)).toBe(expected));
  }
});

describe("dispatchCommand does not take the session down", () => {
  it("turns a handler throw into a failed CommandResult", async () => {
    const exploding = {
      listServers() {
        throw new Error("boom from the registry");
      },
    };
    const res = await dispatchCommand({
      command: "/mcp list",
      mcpRegistry: exploding,
    } as unknown as CommandContext);
    expect(res?.success).toBe(false);
    expect(res?.response).toContain("boom from the registry");
  });
});
