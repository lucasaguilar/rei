import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "./agent.js";
import { MockProvider } from "../providers/mock-provider.js";
import type { ChatMessage, ChatSession } from "../chat/types.js";
import type { ToolDefinition, ChatCompletionWithTools } from "../providers/model-provider.js";

/**
 * Regression: the backend's measured prompt size — which decides when a history gets compacted —
 * lived on the Agent. The CLI has one session per Agent, so that was invisible; the WhatsApp channel
 * serves every customer from ONE Agent, so customer A's long conversation made customer B's first
 * message look oversized, and B's history was compacted (a model call, and lost context) for
 * nothing. The measurement belongs to the conversation it measured.
 */

/** Reports whatever prompt size it is told to, as a real backend reports its own count. */
class Measuring extends MockProvider {
  promptTokens = 0;
  async completeChatWithTools(
    _m: ChatMessage[],
    _t: ToolDefinition[],
    _o?: unknown,
  ): Promise<ChatCompletionWithTools> {
    return {
      content: "ok",
      toolCalls: [],
      finishReason: "stop",
      usage: { promptTokens: this.promptTokens },
    } as ChatCompletionWithTools;
  }
}

let ws: string;
const savedEnv = { ...process.env };
beforeAll(() => {
  ws = mkdtempSync(join(tmpdir(), "rei-compact-session-"));
  process.env.MODEL_PROVIDER = "mock";
  process.env.REI_SKIP_RAG = "1";
  process.env.REI_ON_DEMAND_FILE_CONTEXT = "1";
  process.env.REI_CONTEXT_WINDOW = "32000";
});
afterAll(() => {
  rmSync(ws, { recursive: true, force: true });
  process.env = { ...savedEnv };
});

const newSession = () =>
  ({ messages: [], mode: "ask", createdAt: new Date().toISOString() }) as unknown as ChatSession;

async function turn(agent: Agent, session: ChatSession, input: string): Promise<string[]> {
  const statuses: string[] = [];
  for await (const _ of agent.streamTurn(session, input, { onStatus: (s) => statuses.push(s) })) {
    /* drain */
  }
  return statuses;
}

describe("compaction is decided per conversation, not per Agent", () => {
  it("one customer's huge history does not compact another customer's first message", async () => {
    const provider = new Measuring();
    const agent = new Agent(provider as never, ws);

    provider.promptTokens = 900_000; // customer A: far past the 32k window
    await turn(agent, newSession(), "a long conversation");

    // Customer B: a returning customer with a SHORT history — enough messages to be compactable,
    // nowhere near the window. Only A's measurement could make it look full.
    const b = newSession();
    for (let i = 0; i < 12; i++) {
      b.messages.push({ role: i % 2 ? "assistant" : "user", content: `short message ${i}` });
    }
    provider.promptTokens = 50;
    const statusesB = await turn(agent, b, "hola");
    expect(statusesB).not.toContain("compacting_memory");
  });
});
