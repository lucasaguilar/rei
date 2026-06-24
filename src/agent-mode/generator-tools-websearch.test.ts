/**
 * Verifies the built-in web_search tool is wired into the NATIVE (function-calling)
 * agent path. Before this, web_search lived only in the XML path / UTILITY_TOOLS, so an
 * agent-mode request like "search the web" had no REI tool to call on the native path and
 * the model would reach for an unrelated MCP tool (or do nothing).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the actual web search so the test is offline and deterministic.
vi.mock("../tools/search-tool.js", () => ({
  searchWeb: vi.fn().mockResolvedValue("Buenos Aires: 18°C, clear skies."),
}));

import { executeAgentTurnWithTools } from "./generator-tools.js";
import { searchWeb } from "../tools/search-tool.js";
import type {
  ModelProvider,
  ChatCompletionWithTools,
} from "../providers/model-provider.js";

const fakeLogger = new Proxy(
  {},
  { get: () => vi.fn() },
) as never;

/** A provider that returns each queued tool-call response in order. */
function makeToolProvider(
  responses: ChatCompletionWithTools[],
): ModelProvider {
  let call = 0;
  return {
    completeChatWithTools: vi.fn(async () => responses[call++] ?? responses[responses.length - 1]),
  } as unknown as ModelProvider;
}

describe("executeAgentTurnWithTools — built-in web_search", () => {
  beforeEach(() => vi.clearAllMocks());

  it("dispatches a native web_search tool call to searchWeb and finishes", async () => {
    const provider = makeToolProvider([
      // Turn 1: the model calls web_search.
      {
        content: "",
        reasoning: "",
        finishReason: "stop",
        toolCalls: [
          {
            id: "call_1",
            function: {
              name: "web_search",
              arguments: JSON.stringify({ query: "weather buenos aires" }),
            },
          },
        ],
      } as unknown as ChatCompletionWithTools,
      // Turn 2: with the result fed back, the model answers and stops.
      {
        content: "It's 18°C and clear in Buenos Aires.",
        reasoning: "",
        finishReason: "stop",
        toolCalls: [],
      } as unknown as ChatCompletionWithTools,
    ]);

    const outcome = await executeAgentTurnWithTools({
      provider,
      messagesForModel: [{ role: "user", content: "search the web for the weather" }],
      workspacePath: "/tmp/rei-websearch-test",
      logger: fakeLogger,
    });

    // The wiring under test: the native tool call reached REI's own searchWeb.
    expect(searchWeb).toHaveBeenCalledTimes(1);
    expect(searchWeb).toHaveBeenCalledWith("weather buenos aires", provider);
    // And the turn completed using the model's follow-up answer.
    expect(outcome.response).toContain("Buenos Aires");
  });
});
