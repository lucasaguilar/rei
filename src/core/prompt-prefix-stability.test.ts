import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "./agent.js";
import { MockProvider } from "../providers/mock-provider.js";
import type { ChatMessage, ChatSession } from "../chat/types.js";
import type { ToolDefinition, ChatCompletionWithTools } from "../providers/model-provider.js";

/**
 * THE INVARIANT: what the model received on turn N must be a byte-exact PREFIX of what it receives
 * on turn N+1.
 *
 * Local runtimes keep the KV cache of the last prompt and reuse it only while the next prompt
 * EXTENDS it. One changed byte early in the history and the backend re-reads everything. Measured
 * against oMLX (Qwen3.8-27B-MLX-4bit, ~27.5k tokens, max_tokens=1 to isolate prefill):
 *
 *   prefix preserved  →  0.73s
 *   prefix broken     →  61.11s   (with a SMALLER prompt)
 *
 * REI broke it by storing the raw user input while sending an enriched copy: the next turn re-sent
 * the same message stripped back to raw. The fix is to store what was sent.
 *
 * Tool traffic is persisted between turns — it lives AFTER the last user message, so it extends
 * the cached prefix instead of breaking it (the agent-mode block below asserts exactly this).
 */
class Capturing extends MockProvider {
  readonly calls: ChatMessage[][] = [];
  private readonly script: ChatCompletionWithTools[];
  constructor(
    private readonly reply = "Respuesta.",
    script: ChatCompletionWithTools[] = [],
  ) {
    super();
    this.script = [...script];
  }
  async completeChatWithTools(
    messages: ChatMessage[],
    _tools: ToolDefinition[],
    _options?: unknown,
  ): Promise<ChatCompletionWithTools> {
    this.calls.push(JSON.parse(JSON.stringify(messages)) as ChatMessage[]);
    return (
      this.script.shift() ?? { content: this.reply, toolCalls: [], finishReason: "stop" }
    );
  }
}

/** One scripted turn that asks for a tool, so the loop appends real plumbing to the history. */
const toolTurn = (cmd: string): ChatCompletionWithTools => ({
  content: "Voy a mirar.",
  toolCalls: [
    {
      id: "call_1",
      type: "function",
      function: { name: "run_command", arguments: JSON.stringify({ command: cmd }) },
    },
  ],
  finishReason: "tool_calls",
});

let ws: string;
const savedEnv = { ...process.env };

beforeAll(() => {
  ws = mkdtempSync(join(tmpdir(), "rei-prefix-"));
  writeFileSync(join(ws, "a.ts"), "export const a = 1;\n");
  writeFileSync(join(ws, "b.ts"), "export const b = 2;\n");
  process.env.MODEL_PROVIDER = "mock";
  process.env.REI_SKIP_RAG = "1";
  process.env.REI_ON_DEMAND_FILE_CONTEXT = "1";
});
afterAll(() => {
  rmSync(ws, { recursive: true, force: true });
  process.env = { ...savedEnv };
});

async function runTurns(provider: Capturing, prompts: string[]): Promise<void> {
  const agent = new Agent(provider as never, ws);
  const session = { messages: [], mode: "ask", createdAt: Date.now() } as unknown as ChatSession;
  for (const p of prompts) {
    for await (const _chunk of agent.streamTurn(session, p)) {
      /* drain */
    }
  }
}

/** Index of the first message that differs, or -1 when one is a clean prefix of the other. */
function firstDivergence(a: ChatMessage[], b: ChatMessage[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i].role !== b[i].role || a[i].content !== b[i].content) return i;
  }
  return -1;
}

describe("the prompt grows by appending, never by rewriting", () => {
  it("re-sends turn 1 exactly as turn 1 saw it", async () => {
    const provider = new Capturing();
    await runTurns(provider, ["primera pregunta", "segunda pregunta"]);
    expect(provider.calls.length).toBe(2);

    const [t1, t2] = provider.calls;
    const at = firstDivergence(t1, t2);
    const detail =
      at === -1
        ? ""
        : `diverge en #${at} (${t1[at].role}): ` +
          `turno1=${JSON.stringify(t1[at].content.slice(0, 80))} vs ` +
          `turno2=${JSON.stringify(t2[at].content.slice(0, 80))}`;
    expect(detail).toBe("");
    expect(at, detail).toBe(-1);
  });

  it("only ADDS messages — the turn 2 prompt is strictly longer", async () => {
    const provider = new Capturing();
    await runTurns(provider, ["primera", "segunda"]);
    const [t1, t2] = provider.calls;
    expect(t2.length).toBeGreaterThan(t1.length);
  });

  it("carries the turn context in the stored message, not in a send-time patch", async () => {
    // The enrichment (workspace, repo summary) must BE the stored user message. If it were added
    // at send time, the next turn would re-send the bare input and break the prefix.
    const provider = new Capturing();
    await runTurns(provider, ["explicame el parser"]);
    const userMsg = provider.calls[0].find((m) => m.role === "user");
    expect(userMsg?.content).toContain("explicame el parser");
    expect(userMsg?.content).toContain("Workspace:");
  });
});

describe("nothing rewrites history between turns", () => {
  /**
   * The last per-render transformation was the gist: it demoted old assistant answers to their
   * headline, which rewrote the prompt mid-history the turn a boundary was crossed. On a real
   * session that saved 1,864 tokens (5% of the prompt, while untouched tool traffic was 80%) and
   * cost 132 seconds of re-prefill. Shrinking history belongs to the compactor, by threshold.
   *
   * So the bar is no longer "a minority of turns" — it is none.
   */
  it("keeps every turn a pure extension across a long session", async () => {
    // Multi-line prose: exactly the shape the gist used to collapse.
    const provider = new Capturing("## Titulo\n\nprimera linea de prosa\n\nsegunda linea de prosa");
    const prompts = ["uno", "dos", "tres", "cuatro", "cinco", "seis", "siete", "ocho", "nueve"];
    await runTurns(provider, prompts);

    const calls = provider.calls;
    expect(calls.length).toBe(prompts.length);
    const rewrote = calls
      .slice(1)
      .map((c, i) => ({ turn: i + 2, at: firstDivergence(calls[i], c) }))
      .filter((r) => r.at !== -1);
    expect(rewrote).toEqual([]);
  });

  it("still lets the prompt grow — nothing is silently dropped either", async () => {
    const provider = new Capturing("## Titulo\n\nuna linea\n\notra linea");
    await runTurns(provider, ["uno", "dos", "tres", "cuatro", "cinco"]);
    const calls = provider.calls;
    for (let i = 1; i < calls.length; i++) {
      expect(calls[i].length).toBeGreaterThan(calls[i - 1].length);
    }
  });
});

describe("agent mode: the turn's tool traffic stays in the history", () => {
  /**
   * The loop makes several model calls per turn, each adding its tool request and the result. Those
   * messages used to be discarded when the turn ended, so the next turn's prompt diverged from what
   * the backend had cached — mid-history, which costs a full re-prefill (40.36s vs 0.59s on oMLX).
   */
  async function runAgentTurns(provider: Capturing, prompts: string[]): Promise<void> {
    const agent = new Agent(provider as never, ws);
    const session = {
      messages: [],
      mode: "agent",
      createdAt: Date.now(),
    } as unknown as ChatSession;
    for (const p of prompts) {
      for await (const _chunk of agent.streamTurn(session, p)) {
        /* drain */
      }
    }
  }

  it("keeps what the model saw at the end of turn 1 as a prefix of turn 2", async () => {
    const provider = new Capturing("Listo.", [toolTurn("echo hola")]);
    await runAgentTurns(provider, ["mira el repo", "y ahora que?"]);

    // call 0: turn 1 opening · call 1: turn 1 after the tool ran · call 2: turn 2 opening
    expect(provider.calls.length).toBeGreaterThanOrEqual(3);
    const endOfTurn1 = provider.calls[1];
    const startOfTurn2 = provider.calls[2];

    const at = firstDivergence(endOfTurn1, startOfTurn2);
    const detail =
      at === -1
        ? ""
        : `diverge en #${at} (${endOfTurn1[at]?.role} vs ${startOfTurn2[at]?.role})`;
    expect(detail).toBe("");
  });

  it("carries the tool request and its result, paired", async () => {
    const provider = new Capturing("Listo.", [toolTurn("echo hola")]);
    await runAgentTurns(provider, ["mira el repo", "seguimos"]);

    const turn2 = provider.calls[2];
    const toolMsg = turn2.find((m) => m.role === "tool");
    expect(toolMsg).toBeDefined();
    // The result must still be answering a request that is present, by id.
    const requester = turn2.find(
      (m) => m.role === "assistant" && m.tool_calls?.some((c) => c.id === toolMsg?.tool_call_id),
    );
    expect(requester).toBeDefined();
  });
});
