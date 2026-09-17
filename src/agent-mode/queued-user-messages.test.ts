import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeAgentTurnWithTools } from "./generator-tools.js";
import { MockProvider } from "../providers/mock-provider.js";
import type { ChatMessage } from "../chat/types.js";
import type { ToolDefinition, ChatCompletionWithTools } from "../providers/model-provider.js";

/**
 * Typing while a turn runs used to do nothing: `submitInput` returned early on `state.busy` and the
 * line was gone — including the one that would have unblocked the turn ("the token is in ~/.config"),
 * which you then retyped after watching it go the wrong way.
 *
 * The queue is handed over BETWEEN model responses: after one finishes and its tools have run,
 * before the next call. Never mid-generation — a message cannot land inside a token being written,
 * and stopping the turn outright is what Ctrl-C is for.
 */
class Scripted extends MockProvider {
  readonly seen: ChatMessage[][] = [];
  private turns: ChatCompletionWithTools[];
  constructor(turns: ChatCompletionWithTools[]) {
    super();
    this.turns = [...turns];
  }
  async completeChatWithTools(
    messages: ChatMessage[],
    _tools: ToolDefinition[],
  ): Promise<ChatCompletionWithTools> {
    this.seen.push(JSON.parse(JSON.stringify(messages)) as ChatMessage[]);
    return this.turns.shift() ?? { content: "listo", toolCalls: [], finishReason: "stop" };
  }
}

/** The loop reports through a handful of logger methods; none of them matter here. */
const silentLogger = () =>
  new Proxy({}, { get: () => () => {} }) as never;

const toolCall = (cmd: string): ChatCompletionWithTools => ({
  content: "",
  toolCalls: [
    {
      id: `c${Math.random().toString(36).slice(2, 7)}`,
      type: "function",
      function: { name: "run_command", arguments: JSON.stringify({ command: cmd }) },
    },
  ],
  finishReason: "tool_calls",
});

async function runTurn(provider: Scripted, queue: string[][]) {
  const ws = mkdtempSync(join(tmpdir(), "rei-queue-"));
  writeFileSync(join(ws, "a.ts"), "export const a = 1;\n");
  try {
    const drops = [...queue];
    return await executeAgentTurnWithTools({
      provider: provider as never,
      messagesForModel: [{ role: "user", content: "arreglá el parser" }],
      workspacePath: ws,
      logger: silentLogger(),
      drainUserMessages: () => drops.shift() ?? [],
    });
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
}

describe("a message typed while the turn runs reaches it", () => {
  it("arrives after the model's response, as a user message", async () => {
    const provider = new Scripted([toolCall("echo uno"), toolCall("echo dos")]);
    await runTurn(provider, [["el token está en ~/.config/jira/token"]]);

    // Second call: the queue was drained after the first response.
    const second = provider.seen[1];
    const mine = second.find((m) => m.role === "user" && m.content.includes("el token está"));
    expect(mine, "the queued message never reached the model").toBeDefined();
  });

  it("marks it so the model does not read it as a new task", async () => {
    const provider = new Scripted([toolCall("echo uno")]);
    await runTurn(provider, [["mirá también el .env"]]);
    const mine = provider.seen[1].find((m) => m.role === "user" && m.content.includes(".env"));
    expect(mine?.content).toContain("[USER, mid-turn]");
  });

  it("keeps several in the order they were typed", async () => {
    const provider = new Scripted([toolCall("echo uno")]);
    await runTurn(provider, [["primero", "segundo"]]);
    const texts = provider.seen[1].filter((m) => m.role === "user").map((m) => m.content);
    const a = texts.findIndex((t) => t.includes("primero"));
    const b = texts.findIndex((t) => t.includes("segundo"));
    expect(a).toBeGreaterThanOrEqual(0);
    expect(b).toBeGreaterThan(a);
  });

  it("changes nothing when nothing was typed", async () => {
    const provider = new Scripted([toolCall("echo uno")]);
    await runTurn(provider, [[]]);
    const users = provider.seen[1].filter((m) => m.role === "user");
    expect(users).toHaveLength(1); // only the original task
  });

  it("works with no queue wired at all (server, one-shot, bench)", async () => {
    const provider = new Scripted([toolCall("echo uno")]);
    const ws = mkdtempSync(join(tmpdir(), "rei-queue-"));
    const out = await executeAgentTurnWithTools({
      provider: provider as never,
      messagesForModel: [{ role: "user", content: "hola" }],
      workspacePath: ws,
      logger: silentLogger(),
    });
    rmSync(ws, { recursive: true, force: true });
    expect(out.response).toBeDefined();
  });
});
