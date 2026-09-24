/**
 * Loop guard phase 2, end to end through the real agent loop: what the model sees after a cut.
 *
 * The behaviors that matter are (a) the looping text never comes back in the prompt — re-feeding it
 * is what keeps the loop alive — and (b) the model gets exactly ONE clean retry before REI stops.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { executeAgentTurnWithTools } from "./generator-tools.js";
import type { ChatMessage } from "../chat/types.js";
import type { ModelProvider, ChatCompletionWithTools } from "../providers/model-provider.js";

const fakeLogger = new Proxy({}, { get: () => vi.fn() }) as never;

const LOOPING = "I will check the config. I will check the config. I will check the config.";

/** A response the loop guard cut mid-generation. */
function looped(): ChatCompletionWithTools {
  return {
    content: LOOPING,
    reasoning: "",
    finishReason: "stop",
    stoppedEarly: "repetition",
    toolCalls: [],
  } as unknown as ChatCompletionWithTools;
}

function answer(text: string): ChatCompletionWithTools {
  return { content: text, reasoning: "", finishReason: "stop", toolCalls: [] } as unknown as ChatCompletionWithTools;
}

function toolCall(name: string, args: unknown): ChatCompletionWithTools {
  return {
    content: "",
    reasoning: "",
    finishReason: "stop",
    toolCalls: [{ id: `c_${name}`, function: { name, arguments: JSON.stringify(args) } }],
  } as unknown as ChatCompletionWithTools;
}

/** Records the messages each call was made with, so we can assert what the model was shown. */
function makeProvider(responses: ChatCompletionWithTools[]) {
  const prompts: ChatMessage[][] = [];
  let call = 0;
  const provider = {
    completeChat: vi.fn(async () => "done"),
    completeChatWithTools: vi.fn(async (messages: ChatMessage[]) => {
      prompts.push(messages.map((m) => ({ ...m })));
      return responses[call++] ?? responses[responses.length - 1];
    }),
  } as unknown as ModelProvider;
  return { provider, prompts };
}

describe("executeAgentTurnWithTools — loop guard phase 2", () => {
  let ws: string;
  const saved = process.env.REI_LOOP_GUARD;

  beforeEach(() => {
    ws = fs.mkdtempSync(path.join(os.tmpdir(), "rei-loopguard-"));
  });
  afterEach(() => {
    fs.rmSync(ws, { recursive: true, force: true });
    if (saved === undefined) delete process.env.REI_LOOP_GUARD;
    else process.env.REI_LOOP_GUARD = saved;
  });

  it("retries once and returns the answer the model gives on the second attempt", async () => {
    const { provider } = makeProvider([looped(), answer("FINAL-ANSWER-OK")]);
    const outcome = await executeAgentTurnWithTools({
      provider,
      messagesForModel: [{ role: "user", content: "go" }],
      workspacePath: ws,
      logger: fakeLogger,
    });
    expect(outcome.response).toContain("FINAL-ANSWER-OK");
    expect(outcome.response).not.toContain("I will check the config");
  });

  it("never re-feeds the looping text, and nudges with a user turn instead", async () => {
    const { provider, prompts } = makeProvider([looped(), answer("ok")]);
    await executeAgentTurnWithTools({
      provider,
      messagesForModel: [{ role: "user", content: "go" }],
      workspacePath: ws,
      logger: fakeLogger,
    });

    const retryPrompt = prompts[1];
    expect(JSON.stringify(retryPrompt)).not.toContain("I will check the config");
    const last = retryPrompt[retryPrompt.length - 1];
    expect(last.role).toBe("user");
    expect(last.content).toMatch(/stuck repeating itself/i);
  });

  it("offers the ask_user door only when an interactive frontend is attached", async () => {
    const withElicit = makeProvider([looped(), answer("ok")]);
    await executeAgentTurnWithTools({
      provider: withElicit.provider,
      messagesForModel: [{ role: "user", content: "go" }],
      workspacePath: ws,
      logger: fakeLogger,
      elicit: async (e) => ({ id: e.id, value: e.default }),
    });
    expect(withElicit.prompts[1][withElicit.prompts[1].length - 1].content).toContain("ask_user");

    const headless = makeProvider([looped(), answer("ok")]);
    await executeAgentTurnWithTools({
      provider: headless.provider,
      messagesForModel: [{ role: "user", content: "go" }],
      workspacePath: ws,
      logger: fakeLogger,
    });
    expect(headless.prompts[1][headless.prompts[1].length - 1].content).not.toContain("ask_user");
  });

  it("stops for real when the retry loops too — one retry, not a retry per turn", async () => {
    const { provider } = makeProvider([looped(), looped(), answer("NEVER-REACHED")]);
    const outcome = await executeAgentTurnWithTools({
      provider,
      messagesForModel: [{ role: "user", content: "go" }],
      workspacePath: ws,
      logger: fakeLogger,
    });
    expect(outcome.response).not.toContain("NEVER-REACHED");
    expect(outcome.response).toMatch(/kept repeating itself/i);
    // Two model calls consumed: the loop, the retry. The third response was never requested.
    expect((provider.completeChatWithTools as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);
  });

  it("does not consume the retry on turns the guard did not cut", async () => {
    fs.writeFileSync(path.join(ws, "a.txt"), "hello\n");
    const { provider } = makeProvider([
      toolCall("read_files", { paths: ["a.txt"] }), // a productive turn before the loop
      looped(),
      answer("RECOVERED"),
    ]);
    const outcome = await executeAgentTurnWithTools({
      provider,
      messagesForModel: [{ role: "user", content: "go" }],
      workspacePath: ws,
      logger: fakeLogger,
    });
    expect(outcome.response).toContain("RECOVERED");
  });
});
