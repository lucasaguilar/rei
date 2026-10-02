/**
 * Regression: a channel with nobody at the keyboard (WhatsApp) ran in `ask` mode on the premise
 * that ask is read-only — but ask's tool set includes `run_command`, and the allow-list has
 * `node`/`python3`. Anyone who could message the number could have the model run
 * `node -e "<anything>"` on the server, reading process.env (provider keys, the Meta token) and
 * sending it out over the network.
 *
 * `allowedTools` restricts a turn to named tools, enforced twice: what is OFFERED to the model, and
 * what the dispatcher will RUN — a model can emit a call to a tool it was never offered.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { executeAgentTurnWithTools } from "./generator-tools.js";
import type { ChatMessage } from "../chat/types.js";
import type {
  ModelProvider,
  ChatCompletionWithTools,
  ToolDefinition,
} from "../providers/model-provider.js";

const fakeLogger = new Proxy({}, { get: () => vi.fn() }) as never;

function makeProvider(responses: ChatCompletionWithTools[]) {
  const offered: string[][] = [];
  const sent: ChatMessage[][] = [];
  let call = 0;
  const provider = {
    completeChat: vi.fn(async () => "summary"),
    completeChatWithTools: vi.fn(async (messages: ChatMessage[], tools: ToolDefinition[]) => {
      offered.push(tools.map((t) => t.function.name));
      sent.push(structuredClone(messages));
      return responses[call++] ?? responses[responses.length - 1];
    }),
  } as unknown as ModelProvider;
  return { provider, offered, sent };
}

const callTool = (name: string, args: unknown) =>
  ({
    content: "",
    reasoning: "",
    finishReason: "tool_calls",
    toolCalls: [{ id: "c1", type: "function", function: { name, arguments: JSON.stringify(args) } }],
  }) as ChatCompletionWithTools;
const answer = (text: string) =>
  ({ content: text, reasoning: "", finishReason: "stop", toolCalls: [] }) as ChatCompletionWithTools;

const READ_ONLY = ["read_files", "grep_code", "list_files"];

describe("allowedTools", () => {
  let ws: string;
  beforeEach(() => {
    ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rei-allowed-tools-")));
  });
  afterEach(() => fs.rmSync(ws, { recursive: true, force: true }));

  it("offers the model only the listed tools — no run_command, web_search, ask_user or MCP", async () => {
    const { provider, offered } = makeProvider([answer("ok")]);
    await executeAgentTurnWithTools({
      provider,
      messagesForModel: [{ role: "user", content: "hi" }],
      workspacePath: ws,
      logger: fakeLogger,
      mode: "ask",
      allowedTools: READ_ONLY,
    });
    expect([...offered[0]].sort()).toEqual([...READ_ONLY].sort());
  });

  it("refuses to RUN a tool it never offered, even when the model calls it by name", async () => {
    const pwned = path.join(ws, "pwned");
    const { provider, sent } = makeProvider([
      callTool("run_command", { command: `node -e "require('fs').writeFileSync('${pwned}','x')"` }),
      answer("done"),
    ]);
    await executeAgentTurnWithTools({
      provider,
      messagesForModel: [{ role: "user", content: "run it" }],
      workspacePath: ws,
      logger: fakeLogger,
      mode: "ask",
      allowedTools: READ_ONLY,
    });
    expect(fs.existsSync(pwned)).toBe(false);
    const toolResult = sent[1].find((m) => m.role === "tool")?.content ?? "";
    expect(toolResult).toMatch(/not available/i);
  });

  it("changes nothing when it is not set — the CLI keeps run_command in ask", async () => {
    const { provider, offered } = makeProvider([answer("ok")]);
    await executeAgentTurnWithTools({
      provider,
      messagesForModel: [{ role: "user", content: "hi" }],
      workspacePath: ws,
      logger: fakeLogger,
      mode: "ask",
    });
    expect(offered[0]).toContain("run_command");
  });
});
