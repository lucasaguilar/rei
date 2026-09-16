import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "./agent.js";
import { MockProvider } from "../providers/mock-provider.js";
import type { ChatMessage, ChatSession, SessionMode } from "../chat/types.js";
import type { ToolDefinition, ChatCompletionWithTools } from "../providers/model-provider.js";

/**
 * THE SYSTEM PROMPT ALWAYS TRAVELS.
 *
 * It used to be built inside `updateSystemContextWithRepoMap`, which on-demand file context skips —
 * and on-demand is the DEFAULT for every mode. So REI's identity, the response rules, the mode's
 * instructions, the project's own rules and the verify command were not sent AT ALL: the model got
 * the tool-calling directive and nothing else.
 *
 * Measured on a real turn against oMLX, with the server logging full bodies:
 *
 *   REI_ON_DEMAND_FILE_CONTEXT_AGENT=1 →  1 system message,  1,688 chars
 *   REI_ON_DEMAND_FILE_CONTEXT_AGENT=0 →  2 system messages, 10,633 chars
 *
 * Nothing in the suite noticed, because every other test asserts on what REI SENDS to the tools
 * loop rather than on what the loop sends to the model. This one goes all the way to the provider.
 */
class Capturing extends MockProvider {
  readonly calls: ChatMessage[][] = [];
  async completeChatWithTools(
    messages: ChatMessage[],
    _tools: ToolDefinition[],
    _options?: unknown,
  ): Promise<ChatCompletionWithTools> {
    this.calls.push(JSON.parse(JSON.stringify(messages)) as ChatMessage[]);
    return { content: "ok", toolCalls: [], finishReason: "stop" };
  }
}

let ws: string;
const saved = { ...process.env };
beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), "rei-sysprompt-"));
  writeFileSync(join(ws, "a.ts"), "export const a = 1;\n");
  process.env.MODEL_PROVIDER = "mock";
  process.env.REI_SKIP_RAG = "1";
});
afterEach(() => {
  rmSync(ws, { recursive: true, force: true });
  process.env = { ...saved };
});

/** Runs one turn and returns the system messages the PROVIDER actually received. */
async function systemMessagesSent(mode: SessionMode, onDemand: "0" | "1"): Promise<ChatMessage[]> {
  // Both keys: the per-mode one wins over the general one, and a stale per-mode value in the
  // environment is exactly what made an earlier version of this check pass by accident.
  process.env.REI_ON_DEMAND_FILE_CONTEXT = onDemand;
  for (const m of ["ASK", "PLANNING", "AGENT"]) {
    process.env[`REI_ON_DEMAND_FILE_CONTEXT_${m}`] = onDemand;
  }
  const provider = new Capturing();
  const agent = new Agent(provider as never, ws);
  const session = { messages: [], mode, createdAt: Date.now() } as unknown as ChatSession;
  for await (const _chunk of agent.streamTurn(session, "hola")) {
    /* drain */
  }
  return provider.calls[0].filter((m) => m.role === "system");
}

describe("the system prompt always travels", () => {
  it.each([
    ["agent", "1"],
    ["agent", "0"],
    ["ask", "1"],
    ["ask", "0"],
    ["planning", "1"],
    ["planning", "0"],
  ] as const)("mode=%s on-demand=%s", async (mode, onDemand) => {
    const system = await systemMessagesSent(mode as SessionMode, onDemand);
    const all = system.map((m) => m.content).join("\n");

    // REI's identity — the first line of prompts/shared/base.md.
    expect(all, "the base prompt is missing").toContain("You are REI");
    // Not just a stub: the real prompt carries rules, mode instructions and project rules.
    expect(all.length, `only ${all.length} chars of system prompt`).toBeGreaterThan(5000);
  });

  it("does not depend on the file-context mode at all", async () => {
    // The whole bug: a context-budget flag silently decided whether REI had a personality.
    const on = (await systemMessagesSent("agent", "1")).map((m) => m.content).join("\n");
    const off = (await systemMessagesSent("agent", "0")).map((m) => m.content).join("\n");
    expect(on).toContain("You are REI");
    expect(off).toContain("You are REI");
  });

  it("seats it before the conversation, where a system prompt belongs", async () => {
    const provider = new Capturing();
    const agent = new Agent(provider as never, ws);
    process.env.REI_ON_DEMAND_FILE_CONTEXT_AGENT = "1";
    const session = { messages: [], mode: "agent", createdAt: Date.now() } as unknown as ChatSession;
    for await (const _chunk of agent.streamTurn(session, "hola")) {
      /* drain */
    }
    const sent = provider.calls[0];
    expect(sent[0].role).toBe("system");
    expect(sent[0].content).toContain("You are REI");
    // And the user's turn still comes after it.
    expect(sent.some((m) => m.role === "user")).toBe(true);
  });
});
