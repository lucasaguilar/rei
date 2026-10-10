import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "./agent.js";
import { MockProvider } from "../providers/mock-provider.js";
import { buildSystemMessage } from "../prompts/prompt-builder.js";
import type { ChatMessage, ChatSession } from "../chat/types.js";
import type { ToolDefinition, ChatCompletionWithTools } from "../providers/model-provider.js";
import type { StreamTurnOptions } from "./models/agent.types.js";

/**
 * Phase 3 of docs/persona-spec.md: a session with `persona` set runs as that persona — its prompt
 * instead of REI's, its tools (narrowed by the surface), its knowledge directory, its model — and a
 * session without one is exactly what it was before.
 */

interface Seen {
  messages: ChatMessage[];
  tools: string[];
  model?: string;
}

/** Records every call; answers with the queued responses, then plain text. */
class Recording extends MockProvider {
  seen: Seen[] = [];
  queue: ChatCompletionWithTools[] = [];
  async completeChatWithTools(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    opts?: { model?: string },
  ): Promise<ChatCompletionWithTools> {
    this.seen.push({
      messages: structuredClone(messages),
      tools: tools.map((t) => t.function.name),
      model: opts?.model,
    });
    return this.queue.shift() ?? { content: "ok", toolCalls: [], finishReason: "stop" };
  }
}

let ws: string;
const savedEnv = { ...process.env };
beforeAll(() => {
  process.env.MODEL_PROVIDER = "mock";
  process.env.REI_SKIP_RAG = "1";
  process.env.REI_ON_DEMAND_FILE_CONTEXT = "1";
});
afterAll(() => {
  process.env = { ...savedEnv };
});
beforeEach(() => {
  ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rei-persona-turn-")));
  const dir = path.join(ws, ".rei", "personas");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "sales.md"),
    [
      "---",
      "name: sales",
      "description: Commercial assistant for Acme Co.",
      "tools: [read_files, grep_code, web_search]",
      "knowledgeDir: kb",
      "preferredModel: persona-model",
      "---",
      "",
      "You are the commercial assistant of Acme Co.",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(dir, "concierge.md"),
    "---\nname: concierge\ndescription: d\n---\n\nYou are a concierge.\n",
  );
  fs.mkdirSync(path.join(ws, "kb"));
  fs.writeFileSync(path.join(ws, "kb", "prices.md"), "Plan Pro: $49");
  fs.writeFileSync(path.join(ws, "internal.md"), "INTERNAL-MARGIN 62%");
});

const session = (over: Partial<ChatSession> = {}) =>
  ({ messages: [], mode: "ask", createdAt: new Date().toISOString(), ...over }) as ChatSession;

async function turn(s: ChatSession, input: string, provider: Recording, options?: StreamTurnOptions) {
  const agent = new Agent(provider as never, ws);
  let out = "";
  for await (const chunk of agent.streamTurn(s, input, options)) out += chunk;
  return out;
}
const systemOf = (seen: Seen) => seen.messages.find((m) => m.role === "system")?.content ?? "";
const lastUser = (seen: Seen) => [...seen.messages].reverse().find((m) => m.role === "user")?.content ?? "";

describe("no persona — REI as before", () => {
  it("sends exactly the coding prompt it always did", async () => {
    const p = new Recording();
    await turn(session(), "hola", p);
    expect(systemOf(p.seen[0])).toBe(buildSystemMessage("ask", ws, undefined));
  });
});

describe("a session with a persona", () => {
  it("replaces REI's prompt with the persona's", async () => {
    const p = new Recording();
    await turn(session({ persona: "sales" }), "hola", p);
    const system = systemOf(p.seen[0]);
    expect(system.startsWith("You are the commercial assistant of Acme Co.")).toBe(true);
    expect(system).not.toMatch(/coding agent|Active mode:/);
  });

  it("sends the user's message as typed — no workspace path, repository summary or task framing", async () => {
    const p = new Recording();
    await turn(session({ persona: "sales" }), "¿qué planes tienen?", p);
    expect(lastUser(p.seen[0])).toBe("¿qué planes tienen?");
  });

  it("offers its tools ∩ the surface's, never more", async () => {
    const p = new Recording();
    await turn(session({ persona: "sales" }), "hola", p);
    expect([...p.seen[0].tools].sort()).toEqual(["grep_code", "read_files", "web_search"]);
  });

  it("without a tools field, gets what the surface offers (ask keeps run_command in the CLI)", async () => {
    const p = new Recording();
    await turn(session({ persona: "concierge" }), "hola", p);
    expect(p.seen[0].tools).toContain("run_command");
  });

  it("is narrowed further by a channel's allowedTools", async () => {
    const p = new Recording();
    await turn(session({ persona: "sales" }), "hola", p, {
      allowedTools: ["read_files", "grep_code", "list_files"],
    });
    expect([...p.seen[0].tools].sort()).toEqual(["grep_code", "read_files"]);
  });

  it("reads only inside its knowledgeDir", async () => {
    const p = new Recording();
    p.queue.push({
      content: "",
      finishReason: "tool_calls",
      toolCalls: [
        { id: "c1", type: "function", function: { name: "read_files", arguments: '{"paths":["internal.md"]}' } },
      ],
    } as ChatCompletionWithTools);
    await turn(session({ persona: "sales" }), "margins?", p);
    const toolResult = p.seen[1].messages.filter((m) => m.role === "tool").map((m) => m.content).join("\n");
    expect(toolResult).not.toContain("INTERNAL-MARGIN");
  });

  it("runs on its preferredModel — unless the user chose one with /model", async () => {
    const p = new Recording();
    await turn(session({ persona: "sales" }), "hola", p);
    expect(p.seen[0].model).toBe("persona-model");

    const q = new Recording();
    await turn(session({ persona: "sales", manualModel: "manual-model" }), "hola", q);
    expect(q.seen[0].model).toBe("manual-model");
  });

  it("ignores an active role — a persona and a role do not stack", async () => {
    const p = new Recording();
    await turn(session({ persona: "sales", activeRole: "auditor" }), "hola", p);
    expect(systemOf(p.seen[0])).not.toMatch(/ACTIVE ROLE|Adversarial/);
  });

  it("fails closed when the persona cannot be loaded — no turn as plain REI", async () => {
    const p = new Recording();
    const out = await turn(session({ persona: "ghost" }), "hola", p);
    expect(p.seen).toHaveLength(0);
    expect(out).toMatch(/ghost.*not found/);
  });
});

describe("a persona that writes and uses skills (phase 4b)", () => {
  const createFile = (file: string) =>
    ({
      content: "",
      finishReason: "tool_calls",
      toolCalls: [
        { id: `c-${file}`, type: "function", function: { name: "create_file", arguments: JSON.stringify({ file, content: "<p>hi</p>" }) } },
      ],
    }) as ChatCompletionWithTools;

  beforeEach(() => {
    const dir = path.join(ws, ".rei", "personas");
    fs.writeFileSync(
      path.join(dir, "briefer.md"),
      [
        "---",
        "name: briefer",
        "description: d",
        "tools: [read_files, create_file, edit_file, web_search]",
        "skills: [briefing]",
        'writeGlob: "news/*.html"',
        "---",
        "",
        "You write the morning briefing.",
      ].join("\n"),
    );
    fs.writeFileSync(
      path.join(dir, "nowrite.md"),
      "---\nname: nowrite\ndescription: d\ntools: [read_files, create_file]\n---\n\nYou cannot write.\n",
    );
    fs.mkdirSync(path.join(ws, ".rei", "skills"), { recursive: true });
    // No `modes:` → agent-only for the coding agent; a persona that names it gets it in any mode.
    fs.writeFileSync(path.join(ws, ".rei", "skills", "briefing.md"), "---\nname: briefing\ndescription: the briefing recipe\n---\n\nSteps.\n");
    fs.writeFileSync(path.join(ws, ".rei", "skills", "other.md"), "---\nname: other\ndescription: another recipe\n---\n\nOther steps.\n");
    fs.mkdirSync(path.join(ws, "news"));
  });

  it("writes inside its writeGlob even in ask mode — the mode does not limit a persona", async () => {
    const p = new Recording();
    p.queue.push(createFile("news/today.html"));
    await turn(session({ persona: "briefer", mode: "ask" }), "make today's briefing", p);
    expect(p.seen[0].tools).toContain("create_file");
    expect(fs.existsSync(path.join(ws, "news", "today.html"))).toBe(true);
  });

  it("is refused outside its writeGlob", async () => {
    const p = new Recording();
    p.queue.push(createFile("src/evil.ts"));
    await turn(session({ persona: "briefer", mode: "agent" }), "go", p);
    expect(fs.existsSync(path.join(ws, "src", "evil.ts"))).toBe(false);
  });

  it("without a writeGlob cannot write at all, even with create_file in its tools", async () => {
    const p = new Recording();
    p.queue.push(createFile("news/today.html"));
    await turn(session({ persona: "nowrite", mode: "agent" }), "go", p);
    expect(p.seen[0].tools).not.toContain("create_file");
    expect(fs.existsSync(path.join(ws, "news", "today.html"))).toBe(false);
  });

  it("gets use_skill with only its own skills, and is told about them", async () => {
    const p = new Recording();
    await turn(session({ persona: "briefer", mode: "ask" }), "hola", p);
    expect(p.seen[0].tools).toContain("use_skill");
    // Exactly its own skill in the catalog line — "other" exists in the workspace but is not its.
    expect(systemOf(p.seen[0])).toMatch(/Recipes you can load with use_skill: briefing\./);
  });
});
