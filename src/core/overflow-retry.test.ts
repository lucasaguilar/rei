import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "./agent.js";
import { MockProvider } from "../providers/mock-provider.js";
import type { ChatMessage, ChatSession } from "../chat/types.js";
import type { ToolDefinition, ChatCompletionWithTools } from "../providers/model-provider.js";

/**
 * A backend that refuses the request for being too big used to kill the turn, throwing away every
 * tool call the agent had already run. It is not a bug to surface: the conversation outgrew what
 * the backend takes, and REI already owns the answer — compact, then try again (Pi calls the same
 * path "overflow" compaction, with the aborted turn retried after it).
 *
 * Seen in the wild as two different refusals, both covered by isContextOverflowError:
 *   - "maximum context length is 50176 tokens, but the prompt alone has 51614"
 *   - "oMLX memory guard aborted this request mid-prefill: process memory limit exceeded"
 */
const OVERFLOW = "oMLX memory guard aborted this request mid-prefill: Request aborted: process memory limit exceeded";

class Flaky extends MockProvider {
  calls = 0;
  constructor(private readonly failures: (string | null)[]) {
    super();
  }
  async completeChatWithTools(
    _messages: ChatMessage[],
    _tools: ToolDefinition[],
    _options?: unknown,
  ): Promise<ChatCompletionWithTools> {
    const failure = this.failures[this.calls];
    this.calls += 1;
    if (failure) throw new Error(failure);
    return { content: "Listo.", toolCalls: [], finishReason: "stop" };
  }
}

let ws: string;
const savedEnv = { ...process.env };
beforeAll(() => {
  ws = mkdtempSync(join(tmpdir(), "rei-overflow-"));
  writeFileSync(join(ws, "a.ts"), "export const a = 1;\n");
  process.env.MODEL_PROVIDER = "mock";
  process.env.REI_SKIP_RAG = "1";
  process.env.REI_ON_DEMAND_FILE_CONTEXT = "1";
});
afterAll(() => {
  rmSync(ws, { recursive: true, force: true });
  process.env = { ...savedEnv };
});

async function turn(provider: MockProvider, input = "arregla el parser"): Promise<string> {
  const agent = new Agent(provider as never, ws);
  const session = { messages: [], mode: "agent", createdAt: Date.now() } as unknown as ChatSession;
  let out = "";
  for await (const chunk of agent.streamTurn(session, input)) out += chunk;
  return out;
}

describe("a request the backend refuses for size is retried, not lost", () => {
  it("compacts and completes the turn", async () => {
    const provider = new Flaky([OVERFLOW, null]);
    const out = await turn(provider);
    expect(provider.calls).toBe(2);
    expect(out).toContain("Listo.");
  });

  it("tells the user what happened instead of failing silently", async () => {
    const provider = new Flaky([OVERFLOW, null]);
    expect(await turn(provider)).toContain("compacting and retrying");
  });

  it("retries ONCE — a second refusal is the user's problem to see", async () => {
    // Retrying forever would burn a minute of prefill per attempt and never converge.
    const provider = new Flaky([OVERFLOW, OVERFLOW]);
    await expect(turn(provider)).rejects.toThrow(/memory limit exceeded/);
    expect(provider.calls).toBe(2);
  });

  it("does not retry an error that compacting cannot fix", async () => {
    const provider = new Flaky(["ECONNREFUSED 127.0.0.1:8000"]);
    await expect(turn(provider)).rejects.toThrow(/ECONNREFUSED/);
    expect(provider.calls).toBe(1);
  });

  it("does not retry an out-of-memory raised while generating", async () => {
    // That one is about how the model is loaded, not about how much we sent.
    const provider = new Flaky(["RuntimeError: [metal::malloc] Resource limit (499000) exceeded."]);
    await expect(turn(provider)).rejects.toThrow(/metal::malloc/);
    expect(provider.calls).toBe(1);
  });
});
