/**
 * Regression: a tool call cut off by the output-token cap (finish_reason "length") used to be
 * recorded in history with its half-written JSON arguments. The NEXT request re-sent that history,
 * and LM Studio's chat template cannot parse such arguments — it answers 500 with an HTML error
 * page, killing the turn (seen live: a `rewrite_file` of a whole doc hit the 8192-token cap).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { executeAgentTurnWithTools } from "./generator-tools.js";
import type { ChatMessage } from "../chat/types.js";
import type { ModelProvider, ChatCompletionWithTools } from "../providers/model-provider.js";

const fakeLogger = new Proxy({}, { get: () => vi.fn() }) as never;

/** Returns each queued response in order and snapshots the history sent on every call. */
function makeRecordingProvider(responses: ChatCompletionWithTools[]) {
  const sent: ChatMessage[][] = [];
  let call = 0;
  const provider = {
    completeChat: vi.fn(async () => "summary"),
    completeChatWithTools: vi.fn(async (messages: ChatMessage[]) => {
      sent.push(structuredClone(messages));
      return responses[call++] ?? responses[responses.length - 1];
    }),
  } as unknown as ModelProvider;
  return { provider, sent };
}

function response(
  finishReason: string,
  calls: Array<{ name: string; args: string }>,
): ChatCompletionWithTools {
  return {
    content: "",
    reasoning: "",
    finishReason,
    toolCalls: calls.map((c, i) => ({
      id: `c_${i}`,
      type: "function",
      function: { name: c.name, arguments: c.args },
    })),
  } as ChatCompletionWithTools;
}

const answer = (text: string) =>
  ({ content: text, reasoning: "", finishReason: "stop", toolCalls: [] }) as ChatCompletionWithTools;

/** Every tool call REI sends back must carry JSON the backend's template can parse. */
function unparseableToolCallArgs(history: ChatMessage[]): string[] {
  const bad: string[] = [];
  for (const m of history) {
    for (const tc of m.tool_calls ?? []) {
      try {
        JSON.parse(tc.function.arguments);
      } catch {
        bad.push(tc.function.arguments);
      }
    }
  }
  return bad;
}

const CUT_ARGS = '{"path":"doc.md","content":"# Plan\\n\\nThis document was cut off mid-sen';

describe("tool call truncated by the output-token cap", () => {
  let ws: string;
  const savedEditMode = process.env.REI_EDIT_MODE;

  beforeEach(() => {
    ws = fs.mkdtempSync(path.join(os.tmpdir(), "rei-trunc-call-"));
    process.env.REI_EDIT_MODE = "direct";
    fs.writeFileSync(path.join(ws, "doc.md"), "original\n");
  });
  afterEach(() => {
    fs.rmSync(ws, { recursive: true, force: true });
    if (savedEditMode === undefined) delete process.env.REI_EDIT_MODE;
    else process.env.REI_EDIT_MODE = savedEditMode;
  });

  it("never re-sends the half-written arguments, and tells the model the call did not run", async () => {
    const { provider, sent } = makeRecordingProvider([
      response("length", [{ name: "rewrite_file", args: CUT_ARGS }]),
      answer("Done."),
    ]);

    await executeAgentTurnWithTools({
      provider,
      messagesForModel: [{ role: "user", content: "rewrite doc.md" }],
      workspacePath: ws,
      logger: fakeLogger,
    });

    expect(sent.length).toBeGreaterThanOrEqual(2);
    expect(unparseableToolCallArgs(sent[1])).toEqual([]);
    const lastUser = [...sent[1]].reverse().find((m) => m.role === "user");
    expect(lastUser?.content).toMatch(/not executed/i);
    expect(fs.readFileSync(path.join(ws, "doc.md"), "utf8")).toBe("original\n");
  });

  it("still runs the complete calls that came before the cut one", async () => {
    fs.writeFileSync(path.join(ws, "note.txt"), "NOTE-MARKER-42");
    const { provider, sent } = makeRecordingProvider([
      response("length", [
        { name: "read_files", args: '{"paths":["note.txt"]}' },
        { name: "rewrite_file", args: CUT_ARGS },
      ]),
      answer("Done."),
    ]);

    await executeAgentTurnWithTools({
      provider,
      messagesForModel: [{ role: "user", content: "read note.txt then rewrite doc.md" }],
      workspacePath: ws,
      logger: fakeLogger,
    });

    expect(unparseableToolCallArgs(sent[1])).toEqual([]);
    const toolResults = sent[1].filter((m) => m.role === "tool").map((m) => m.content).join("\n");
    expect(toolResults).toContain("NOTE-MARKER-42");
  });
});
