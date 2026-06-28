import { describe, it, expect, vi, beforeEach } from "vitest";

const { buildFileContextMessage } = vi.hoisted(() => ({
  buildFileContextMessage: vi.fn(),
}));
vi.mock("./patch-helpers.js", async (importActual) => {
  const actual = await importActual<typeof import("./patch-helpers.js")>();
  return { ...actual, buildFileContextMessage };
});

import { injectRequestedFiles } from "./inject-requested-files.js";
import type { ChatSession } from "../../chat/types.js";

const fakeLogger = new Proxy({}, { get: () => vi.fn() }) as never;

describe("injectRequestedFiles", () => {
  beforeEach(() => {
    buildFileContextMessage.mockReset();
    buildFileContextMessage.mockImplementation(
      async (_ws: string, files: string[]) =>
        files.map((f) => `--- File: ${f} ---\ncontent of ${f}`).join("\n\n"),
    );
  });

  it("records the request as an assistant tool_call + matching tool result", async () => {
    const messages: ChatSession["messages"] = [];
    await injectRequestedFiles({
      fileRequests: ["a.ts"],
      rawResponse: "please show a.ts",
      workspacePath: "/ws",
      currentMessages: messages,
      logger: fakeLogger,
    });
    expect(messages).toHaveLength(2);
    const [assistant, tool] = messages;
    expect(assistant.role).toBe("assistant");
    expect(assistant.tool_calls?.[0].function.name).toBe("request_files");
    expect(JSON.parse(assistant.tool_calls![0].function.arguments)).toEqual({
      files: ["a.ts"],
    });
    expect(tool.role).toBe("tool");
    expect(tool.tool_call_id).toBe(assistant.tool_calls![0].id);
    expect(tool.content).toContain("content of a.ts");
  });

  it("serves full content on first request and records it when deduping", async () => {
    const messages: ChatSession["messages"] = [];
    const alreadyProvided = new Map<string, string>();
    await injectRequestedFiles({
      fileRequests: ["a.ts"],
      rawResponse: "r",
      workspacePath: "/ws",
      currentMessages: messages,
      logger: fakeLogger,
      alreadyProvided,
    });
    expect(messages[1].content).toContain("content of a.ts");
    expect(alreadyProvided.has("a.ts")).toBe(true);
  });

  it("points back to an unchanged file instead of re-dumping it (dedup)", async () => {
    const messages: ChatSession["messages"] = [];
    const alreadyProvided = new Map<string, string>();
    const call = () =>
      injectRequestedFiles({
        fileRequests: ["a.ts"],
        rawResponse: "r",
        workspacePath: "/ws",
        currentMessages: messages,
        logger: fakeLogger,
        alreadyProvided,
      });
    await call(); // first serve records it
    await call(); // second serve should dedup
    const second = messages[3];
    expect(second.content).toContain("unchanged since you last read it");
    expect(second.content).not.toContain("content of a.ts");
  });

  it("does NOT dedup when alreadyProvided is omitted (wholefile path)", async () => {
    const messages: ChatSession["messages"] = [];
    const call = () =>
      injectRequestedFiles({
        fileRequests: ["a.ts"],
        rawResponse: "r",
        workspacePath: "/ws",
        currentMessages: messages,
        logger: fakeLogger,
      });
    await call();
    await call();
    expect(messages[1].content).toContain("content of a.ts");
    expect(messages[3].content).toContain("content of a.ts");
  });
});
