/**
 * CHARACTERIZATION TESTS for executeAgentTurnWithTools (the ~920-line native agent loop).
 *
 * These lock the loop's OBSERVED behavior before Phase 2 of the refactor extracts it into named
 * phases (docs/refactor-plan.md). They are intentionally behavior-first: they assert what the
 * loop does today (plain answers, read_files, edit_file apply, batching, malformed-edit safety)
 * so the extraction can be proven behavior-preserving. NOT a spec of desired behavior.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { executeAgentTurnWithTools } from "./generator-tools.js";
import type { ModelProvider, ChatCompletionWithTools } from "../providers/model-provider.js";

const fakeLogger = new Proxy({}, { get: () => vi.fn() }) as never;

/** A provider that returns each queued tool-call response in order (last one repeats).
 *  completeChat is also stubbed — the loop calls it for the "created files" recap summary. */
function makeToolProvider(responses: ChatCompletionWithTools[]): ModelProvider {
  let call = 0;
  return {
    completeChat: vi.fn(async () => "Created the requested file(s)."),
    completeChatWithTools: vi.fn(
      async () => responses[call++] ?? responses[responses.length - 1],
    ),
  } as unknown as ModelProvider;
}

/** Shorthand for a model response that calls one tool. */
function toolCall(name: string, args: unknown): ChatCompletionWithTools {
  return {
    content: "",
    reasoning: "",
    finishReason: "stop",
    toolCalls: [{ id: `c_${name}`, function: { name, arguments: JSON.stringify(args) } }],
  } as unknown as ChatCompletionWithTools;
}

/** Shorthand for a model response with multiple tool calls in ONE turn (batching). */
function toolCalls(
  calls: Array<{ name: string; args: unknown }>,
): ChatCompletionWithTools {
  return {
    content: "",
    reasoning: "",
    finishReason: "stop",
    toolCalls: calls.map((c, i) => ({
      id: `c_${i}`,
      function: { name: c.name, arguments: JSON.stringify(c.args) },
    })),
  } as unknown as ChatCompletionWithTools;
}

/** Shorthand for a final plain answer (no tool calls). */
function answer(text: string): ChatCompletionWithTools {
  return {
    content: text,
    reasoning: "",
    finishReason: "stop",
    toolCalls: [],
  } as unknown as ChatCompletionWithTools;
}

/** Shorthand for a response truncated by the output-token cap (no tool call emitted yet). */
function truncated(text: string): ChatCompletionWithTools {
  return {
    content: text,
    reasoning: "",
    finishReason: "length",
    toolCalls: [],
  } as unknown as ChatCompletionWithTools;
}

describe("executeAgentTurnWithTools — characterization", () => {
  let ws: string;
  const savedEditMode = process.env.REI_EDIT_MODE;

  beforeEach(() => {
    ws = fs.mkdtempSync(path.join(os.tmpdir(), "rei-loop-char-"));
    process.env.REI_EDIT_MODE = "direct"; // apply edits straight to disk (default path)
    vi.clearAllMocks();
  });
  afterEach(() => {
    fs.rmSync(ws, { recursive: true, force: true });
    if (savedEditMode === undefined) delete process.env.REI_EDIT_MODE;
    else process.env.REI_EDIT_MODE = savedEditMode;
  });

  it("returns the model's plain answer when no tools are called", async () => {
    const provider = makeToolProvider([answer("Here is the answer.")]);
    const outcome = await executeAgentTurnWithTools({
      provider,
      messagesForModel: [{ role: "user", content: "what is 2+2?" }],
      workspacePath: ws,
      logger: fakeLogger,
    });
    expect(outcome.response).toContain("Here is the answer.");
    expect(outcome.validProposedPatches).toEqual([]);
  });

  it("reads a file via read_files, then finishes with the model's follow-up answer", async () => {
    fs.writeFileSync(path.join(ws, "note.txt"), "SECRET-MARKER-123");
    const provider = makeToolProvider([
      toolCall("read_files", { paths: ["note.txt"] }),
      answer("The file says SECRET-MARKER-123."),
    ]);
    const outcome = await executeAgentTurnWithTools({
      provider,
      messagesForModel: [{ role: "user", content: "read note.txt" }],
      workspacePath: ws,
      logger: fakeLogger,
    });
    // The loop ran a second model turn after feeding the file back.
    expect((provider.completeChatWithTools as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(outcome.response).toContain("SECRET-MARKER-123");
  });

  it("applies an edit_file change to disk (direct mode)", async () => {
    const file = path.join(ws, "code.ts");
    fs.writeFileSync(file, "const x = 1;\n");
    const provider = makeToolProvider([
      toolCall("edit_file", { file: "code.ts", search: "const x = 1;", replace: "const x = 2;" }),
      answer("Changed x to 2."),
    ]);
    const outcome = await executeAgentTurnWithTools({
      provider,
      messagesForModel: [{ role: "user", content: "set x to 2" }],
      workspacePath: ws,
      logger: fakeLogger,
    });
    expect(fs.readFileSync(file, "utf8")).toContain("const x = 2;");
    expect(outcome.validProposedPatches.length).toBeGreaterThan(0);
  });

  it("applies MULTIPLE edit_file calls from ONE response (batching)", async () => {
    fs.writeFileSync(path.join(ws, "a.ts"), "let a = 0;\n");
    fs.writeFileSync(path.join(ws, "b.ts"), "let b = 0;\n");
    const provider = makeToolProvider([
      toolCalls([
        { name: "edit_file", args: { file: "a.ts", search: "let a = 0;", replace: "let a = 1;" } },
        { name: "edit_file", args: { file: "b.ts", search: "let b = 0;", replace: "let b = 1;" } },
      ]),
      answer("Updated both."),
    ]);
    await executeAgentTurnWithTools({
      provider,
      messagesForModel: [{ role: "user", content: "bump a and b" }],
      workspacePath: ws,
      logger: fakeLogger,
    });
    expect(fs.readFileSync(path.join(ws, "a.ts"), "utf8")).toContain("let a = 1;");
    expect(fs.readFileSync(path.join(ws, "b.ts"), "utf8")).toContain("let b = 1;");
  });

  it("does NOT crash on a malformed edit_file (missing search/replace)", async () => {
    fs.writeFileSync(path.join(ws, "code.ts"), "const x = 1;\n");
    const provider = makeToolProvider([
      toolCall("edit_file", { file: "code.ts" }), // no search/replace
      answer("Done."),
    ]);
    const outcome = await executeAgentTurnWithTools({
      provider,
      messagesForModel: [{ role: "user", content: "edit code.ts" }],
      workspacePath: ws,
      logger: fakeLogger,
    });
    // The file is untouched and the turn still returns a result (no throw).
    expect(fs.readFileSync(path.join(ws, "code.ts"), "utf8")).toBe("const x = 1;\n");
    expect(typeof outcome.response).toBe("string");
  });

  it("feeds back an ERROR and leaves the file untouched on a search-block mismatch", async () => {
    const file = path.join(ws, "code.ts");
    fs.writeFileSync(file, "const x = 1;\n");
    let secondCallMessages: unknown;
    const provider = {
      completeChat: vi.fn(async () => "done"),
      completeChatWithTools: vi
        .fn()
        // Turn 1: edit whose search text is NOT in the file → mismatch.
        .mockImplementationOnce(async () =>
          toolCall("edit_file", {
            file: "code.ts",
            search: "DOES NOT EXIST",
            replace: "whatever",
          }),
        )
        // Turn 2: capture what was fed back, then finish.
        .mockImplementationOnce(async (messages: unknown) => {
          secondCallMessages = messages;
          return answer("ok");
        }),
    } as unknown as ModelProvider;

    await executeAgentTurnWithTools({
      provider,
      messagesForModel: [{ role: "user", content: "edit" }],
      workspacePath: ws,
      logger: fakeLogger,
    });

    // File untouched, and a tool-role ERROR message was fed back for the model to retry.
    expect(fs.readFileSync(file, "utf8")).toBe("const x = 1;\n");
    const toolMsgs = (secondCallMessages as Array<{ role: string; content: string }>).filter(
      (m) => m.role === "tool",
    );
    expect(toolMsgs.some((m) => m.content.startsWith("ERROR:"))).toBe(true);
  });

  it("resets the truncation budget after a productive turn (consecutive, not lifetime, cap)", async () => {
    // 4 truncations total (> the 3-cap) but never 3 in a row: a productive read_files turn in the
    // middle resets the streak. With a lifetime cap the loop would bail early with the
    // "kept hitting the output-token limit" finalize; with a per-streak reset it reaches the answer.
    fs.writeFileSync(path.join(ws, "x.txt"), "hello");
    const provider = makeToolProvider([
      truncated("p1"),
      truncated("p2"),
      toolCall("read_files", { paths: ["x.txt"] }), // productive → resets the streak
      truncated("p3"),
      truncated("p4"),
      answer("FINAL-ANSWER-OK"),
    ]);
    const outcome = await executeAgentTurnWithTools({
      provider,
      messagesForModel: [{ role: "user", content: "go" }],
      workspacePath: ws,
      logger: fakeLogger,
    });
    expect(outcome.response).toContain("FINAL-ANSWER-OK");
    // All six responses were consumed (the loop never bailed on the truncation cap).
    expect(
      (provider.completeChatWithTools as ReturnType<typeof vi.fn>).mock.calls.length,
    ).toBe(6);
  });

  it("creates a new file via create_file (direct mode)", async () => {
    const provider = makeToolProvider([
      toolCall("create_file", { file: "new.ts", content: "export const hi = 1;\n" }),
      answer("Created new.ts."),
    ]);
    await executeAgentTurnWithTools({
      provider,
      messagesForModel: [{ role: "user", content: "create new.ts" }],
      workspacePath: ws,
      logger: fakeLogger,
    });
    expect(fs.existsSync(path.join(ws, "new.ts"))).toBe(true);
    expect(fs.readFileSync(path.join(ws, "new.ts"), "utf8")).toContain("export const hi = 1;");
  });
});
