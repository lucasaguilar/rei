/**
 * Regression: WhatsApp serves many customers from one workspace, and each conversation is stored
 * in that workspace as .rei/sessions/wa-<number>.json. The read-only tools a WhatsApp turn keeps
 * (read_files, list_files, grep_code) are scoped to the workspace — so one customer could ask the
 * model to read, or list, another customer's conversation.
 *
 * `readRoot` confines the read tools to one directory (the knowledge base a support/sales role
 * needs) and keeps `.rei/` — sessions, logs, spills — out of reach for any turn that sets it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { executeAgentTurnWithTools } from "../agent-mode/generator-tools.js";
import type { ChatMessage } from "../chat/types.js";
import type { ModelProvider, ChatCompletionWithTools } from "../providers/model-provider.js";

const fakeLogger = new Proxy({}, { get: () => vi.fn() }) as never;
const WHATSAPP_TOOLS = ["read_files", "grep_code", "list_files"];
const SECRET_CHAT = "ORDER-4471 shipped to Av. Siempre Viva 742";

function provider(responses: ChatCompletionWithTools[]) {
  const sent: ChatMessage[][] = [];
  let i = 0;
  const p = {
    completeChat: vi.fn(async () => ""),
    completeChatWithTools: vi.fn(async (m: ChatMessage[]) => {
      sent.push(structuredClone(m));
      return responses[i++] ?? responses[responses.length - 1];
    }),
  } as unknown as ModelProvider;
  return { p, sent };
}
const call = (name: string, args: unknown) =>
  ({
    content: "",
    reasoning: "",
    finishReason: "tool_calls",
    toolCalls: [{ id: "c1", type: "function", function: { name, arguments: JSON.stringify(args) } }],
  }) as ChatCompletionWithTools;
const done = { content: "ok", reasoning: "", finishReason: "stop", toolCalls: [] } as ChatCompletionWithTools;

describe("one WhatsApp customer cannot reach another's conversation", () => {
  let ws: string;
  beforeEach(() => {
    ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rei-wa-privacy-")));
    fs.mkdirSync(path.join(ws, ".rei", "sessions"), { recursive: true });
    fs.writeFileSync(
      path.join(ws, ".rei", "sessions", "wa-5491100000001.json"),
      JSON.stringify({ messages: [{ role: "user", content: SECRET_CHAT }] }),
    );
  });
  afterEach(() => fs.rmSync(ws, { recursive: true, force: true }));

  async function run(tool: string, args: unknown, readRoot = ws) {
    const { p, sent } = provider([call(tool, args), done]);
    await executeAgentTurnWithTools({
      provider: p,
      messagesForModel: [{ role: "user", content: "go" }],
      workspacePath: ws,
      logger: fakeLogger,
      mode: "ask",
      allowedTools: WHATSAPP_TOOLS,
      readRoot,
    });
    return sent[1].filter((m) => m.role === "tool").map((m) => m.content).join("\n");
  }

  it("read_files refuses a session file", async () => {
    const out = await run("read_files", { paths: [".rei/sessions/wa-5491100000001.json"] });
    expect(out).not.toContain(SECRET_CHAT);
  });

  it("list_files does not reveal who else wrote", async () => {
    const out = await run("list_files", { path: ".rei/sessions" });
    expect(out).not.toContain("5491100000001");
  });

  it("grep_code does not search other conversations", async () => {
    const out = await run("grep_code", { pattern: "ORDER-4471", path: ".rei" });
    expect(out).not.toContain(SECRET_CHAT);
  });

  it("an absolute path or ../ cannot climb out either", async () => {
    const abs = path.join(ws, ".rei", "sessions", "wa-5491100000001.json");
    expect(await run("read_files", { paths: [abs] })).not.toContain(SECRET_CHAT);
    expect(await run("read_files", { paths: ["kb/../.rei/sessions/wa-5491100000001.json"] })).not.toContain(SECRET_CHAT);
  });
});

describe("readRoot confines the read tools to a knowledge base", () => {
  let ws: string;
  beforeEach(() => {
    ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rei-wa-kb-")));
    fs.mkdirSync(path.join(ws, "kb"));
    fs.writeFileSync(path.join(ws, "kb", "prices.md"), "Plan Pro: $49");
    fs.writeFileSync(path.join(ws, "internal.md"), "INTERNAL-MARGIN 62%");
  });
  afterEach(() => fs.rmSync(ws, { recursive: true, force: true }));

  async function run(tool: string, args: unknown) {
    const { p, sent } = provider([call(tool, args), done]);
    await executeAgentTurnWithTools({
      provider: p,
      messagesForModel: [{ role: "user", content: "go" }],
      workspacePath: ws,
      logger: fakeLogger,
      mode: "ask",
      allowedTools: WHATSAPP_TOOLS,
      readRoot: path.join(ws, "kb"),
    });
    return sent[1].filter((m) => m.role === "tool").map((m) => m.content).join("\n");
  }

  it("serves what is inside it", async () => {
    expect(await run("read_files", { paths: ["kb/prices.md"] })).toContain("Plan Pro: $49");
  });

  it("refuses what is outside it", async () => {
    expect(await run("read_files", { paths: ["internal.md"] })).not.toContain("INTERNAL-MARGIN");
    expect(await run("grep_code", { pattern: "INTERNAL-MARGIN" })).not.toContain("internal.md");
    expect(await run("list_files", {})).not.toContain("internal.md");
  });
});
