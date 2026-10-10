/**
 * allowedTools with MCP tool search (docs/persona-spec.md, phase 4). Past 25 MCP tools REI stops
 * sending them all and offers `search_tools` instead. A persona narrows tools by name, so without
 * care it either loses `search_tools` (and every MCP tool but the 8 preloaded) or, given it, could
 * load tools outside its patterns. The MCP set is narrowed at the source: the search only ever sees
 * what the turn allows.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { executeAgentTurnWithTools } from "./generator-tools.js";
import type { ChatMessage } from "../chat/types.js";
import type { ModelProvider, ChatCompletionWithTools, ToolDefinition } from "../providers/model-provider.js";

const fakeLogger = new Proxy({}, { get: () => vi.fn() }) as never;

const mcpTool = (server: string, i: number) => ({
  name: `${server}/tool${i}`,
  description: `${server} tool number ${i}`,
  inputSchema: { type: "object", properties: {} },
});
const registry = (tools: ReturnType<typeof mcpTool>[]) =>
  ({ getAvailableTools: () => tools, dispatch: vi.fn(async () => "ok") }) as never;

function recorder(responses: ChatCompletionWithTools[]) {
  const offered: string[][] = [];
  const toolResults: string[] = [];
  let i = 0;
  const provider = {
    completeChat: vi.fn(async () => ""),
    completeChatWithTools: vi.fn(async (m: ChatMessage[], tools: ToolDefinition[]) => {
      offered.push(tools.map((t) => t.function.name));
      toolResults.push(...m.filter((x) => x.role === "tool").map((x) => String(x.content)));
      return responses[i++] ?? { content: "done", reasoning: "", finishReason: "stop", toolCalls: [] };
    }),
  } as unknown as ModelProvider;
  return { provider, offered, toolResults };
}

const spotify = Array.from({ length: 30 }, (_, i) => mcpTool("spotify", i));
const github = Array.from({ length: 10 }, (_, i) => mcpTool("github", i));
const allowedSpotify = (n: number) => spotify.slice(0, n).map((t) => `mcp:${t.name}`);

describe("allowedTools × MCP tool search", () => {
  let ws: string;
  beforeEach(() => {
    ws = fs.mkdtempSync(path.join(os.tmpdir(), "rei-mcp-allowed-"));
  });
  afterEach(() => fs.rmSync(ws, { recursive: true, force: true }));

  it("allowed MCP tools under the search threshold are all offered, without search_tools", async () => {
    const { provider, offered } = recorder([]);
    await executeAgentTurnWithTools({
      provider,
      messagesForModel: [{ role: "user", content: "play something" }],
      workspacePath: ws,
      logger: fakeLogger,
      mode: "ask",
      mcpRegistry: registry([...spotify, ...github]),
      allowedTools: allowedSpotify(10),
    });
    const mcp = offered[0].filter((n) => n.startsWith("mcp:"));
    expect(mcp).toHaveLength(10);
    expect(mcp.every((n) => n.startsWith("mcp:spotify/"))).toBe(true);
    expect(offered[0]).not.toContain("search_tools");
  });

  it("past the threshold, search_tools is offered — and only ever finds allowed tools", async () => {
    const { provider, offered, toolResults } = recorder([
      {
        content: "",
        reasoning: "",
        finishReason: "tool_calls",
        toolCalls: [
          { id: "s1", type: "function", function: { name: "search_tools", arguments: '{"query":"github issues tool"}' } },
        ],
      } as ChatCompletionWithTools,
    ]);
    await executeAgentTurnWithTools({
      provider,
      messagesForModel: [{ role: "user", content: "open the github issues" }],
      workspacePath: ws,
      logger: fakeLogger,
      mode: "ask",
      mcpRegistry: registry([...spotify, ...github]),
      allowedTools: allowedSpotify(30),
    });
    expect(offered[0]).toContain("search_tools");
    // Offered is not enough: the dispatcher must run it too, not refuse it as "not available".
    expect(toolResults.join("\n")).not.toMatch(/not available/);
    for (const call of offered) {
      expect(call.filter((n) => n.startsWith("mcp:github/"))).toEqual([]);
    }
  });
});
