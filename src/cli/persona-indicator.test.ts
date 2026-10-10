import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ChatRenderer } from "./ui/chat-renderer.js";
import { sessionIndicators } from "./helpers/chat.helpers.js";
import { parseCliArgs } from "./run-cli.js";
import type { ChatRendererState } from "./models/chat.types.js";

/** Phase 4 of docs/persona-spec.md: the CLI shows who REI is, and takes --persona. */

// eslint-disable-next-line no-control-regex
const plain = (s: string): string => s.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
let written: string[] = [];
beforeEach(() => {
  written = [];
  vi.spyOn(process.stdout, "write").mockImplementation((c: unknown) => {
    written.push(String(c));
    return true;
  });
});
afterEach(() => vi.restoreAllMocks());

const draw = (over: Partial<ChatRendererState> = {}): string => {
  ChatRenderer.resetDrawnState();
  ChatRenderer.draw({
    cols: 100,
    rows: 24,
    inputBuffer: "",
    inputCursor: 0,
    sessionMode: "ask",
    activePalette: { kind: "none", items: [] },
    selectedCommandIndex: 0,
    historySearchMode: false,
    historySearchQuery: "",
    inputHistory: [],
    busy: false,
    transcript: [],
    ...over,
  } as unknown as ChatRendererState);
  return plain(written.join(""));
};

describe("the 👤 indicator", () => {
  it("names the active persona above the prompt", () => {
    expect(draw({ persona: "sales" })).toContain("👤 sales");
  });

  it("is absent without one", () => {
    expect(draw()).not.toContain("👤");
  });

  it("hides the 🎭 role while a persona is active — the role is ignored, showing it would lie", () => {
    expect(sessionIndicators({ persona: "sales", activeRole: "auditor" })).toMatchObject({
      persona: "sales",
      activeRole: undefined,
    });
    expect(sessionIndicators({ activeRole: "auditor" }).activeRole).toBe("auditor");
  });
});

describe("--persona", () => {
  it("is parsed in both spellings, and leaves the rest alone", () => {
    expect(parseCliArgs(["--persona", "daily", "chat"])).toMatchObject({ persona: "daily", command: "chat" });
    expect(parseCliArgs(["--persona=sales", "ask", "hola"])).toMatchObject({
      persona: "sales",
      command: "ask",
      commandArgs: ["hola"],
    });
    expect(parseCliArgs(["chat"]).persona).toBeUndefined();
  });
});
