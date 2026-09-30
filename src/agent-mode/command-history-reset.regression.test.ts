/**
 * Regression: the run_command repeat guard forgets its history when a turn changes the disk, so a
 * command whose answer depends on that disk may run again. It forgot only for QUEUED edits
 * (edit_file / rewrite_file), not for create_file, which writes straight to disk.
 *
 * Seen live: the model created `.pr-body.md`, ran `rm .pr-body.md`, created the file AGAIN, and the
 * second `rm` was refused as a no-progress loop. The "STOP, do not call any tool" nudge then threw
 * the model into a reasoning loop, and it finally dodged the guard with `rm -f` — the guard had
 * taught it to route around a control.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { executeAgentTurnWithTools } from "./generator-tools.js";
import type { ChatMessage } from "../chat/types.js";
import type { ModelProvider, ChatCompletionWithTools } from "../providers/model-provider.js";

const fakeLogger = new Proxy({}, { get: () => vi.fn() }) as never;

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

let nextId = 0;
const toolCall = (name: string, args: unknown) =>
  ({
    content: "",
    reasoning: "",
    finishReason: "tool_calls",
    toolCalls: [
      { id: `c_${nextId++}`, type: "function", function: { name, arguments: JSON.stringify(args) } },
    ],
  }) as ChatCompletionWithTools;

const answer = (text: string) =>
  ({ content: text, reasoning: "", finishReason: "stop", toolCalls: [] }) as ChatCompletionWithTools;

const lastToolResult = (history: ChatMessage[]) =>
  history.filter((m) => m.role === "tool").at(-1)?.content ?? "";

describe("run_command repeat guard after create_file", () => {
  let ws: string;
  const savedEditMode = process.env.REI_EDIT_MODE;

  beforeEach(() => {
    ws = fs.mkdtempSync(path.join(os.tmpdir(), "rei-cmd-history-"));
    process.env.REI_EDIT_MODE = "direct";
  });
  afterEach(() => {
    fs.rmSync(ws, { recursive: true, force: true });
    if (savedEditMode === undefined) delete process.env.REI_EDIT_MODE;
    else process.env.REI_EDIT_MODE = savedEditMode;
  });

  it("runs the same command again once create_file has changed the disk", async () => {
    const { provider, sent } = makeRecordingProvider([
      toolCall("run_command", { command: "ls" }),
      toolCall("create_file", { file: "created.txt", content: "x" }),
      toolCall("run_command", { command: "ls" }),
      answer("done"),
    ]);

    await executeAgentTurnWithTools({
      provider,
      messagesForModel: [{ role: "user", content: "list, create a file, list again" }],
      workspacePath: ws,
      logger: fakeLogger,
    });

    // sent[3] is the request after the second `ls`: its last tool result is that command's output.
    const secondLs = lastToolResult(sent[3]);
    expect(secondLs).not.toMatch(/already ran this exact command/);
    expect(secondLs).toContain("created.txt");
  });

  it("still blocks a plain repeat when nothing changed in between", async () => {
    const { provider, sent } = makeRecordingProvider([
      toolCall("run_command", { command: "ls" }),
      toolCall("run_command", { command: "ls" }),
      answer("done"),
    ]);

    await executeAgentTurnWithTools({
      provider,
      messagesForModel: [{ role: "user", content: "list twice" }],
      workspacePath: ws,
      logger: fakeLogger,
    });

    expect(lastToolResult(sent[2])).toMatch(/already ran this exact command/);
  });
});
