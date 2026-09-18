import { describe, it, expect, vi } from "vitest";
import { ChatRenderer } from "./chat-renderer.js";
import type { ChatRendererState } from "../models/chat.types.js";

/** Draws one frame and returns it with the ANSI stripped. */
function drawFrame(overrides: Partial<ChatRendererState>): string {
  // Every escape sequence, not just the colours: the cursor-hide that opens a frame and the
  // column jump that closes it would otherwise show up as content on a row of their own.
  // eslint-disable-next-line no-control-regex
  return drawRaw(overrides).replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
}

/** The same frame with its escape codes intact, for the assertions about styling. */
function drawRaw(overrides: Partial<ChatRendererState>): string {
  const out: string[] = [];
  const spy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk: unknown) => {
      out.push(String(chunk));
      return true;
    });
  ChatRenderer.resetDrawnState();
  ChatRenderer.draw({
    cols: 100,
    rows: 24,
    activePalette: { kind: "command", items: [] },
    selectedCommandIndex: 0,
    historySearchMode: false,
    historySearchQuery: "",
    inputHistory: [],
    busy: true,
    activeStatus: "calling_model",
    statusStartedAt: Date.now() - 47_000,
    spinnerIndex: 1,
    sessionMode: "agent",
    inputBuffer: "pará, estás sobrepensando",
    inputCursor: 25,
    ...overrides,
  } as ChatRendererState);
  spy.mockRestore();
  return out.join("").replace(/\r\n/g, "\n");
}

/**
 * The frame the user is looking at while a local model thinks. The point of putting the reasoning
 * here rather than streaming it is the LAST line: the prompt, with what they are typing in it,
 * still on screen and still theirs — a free-running stream erases this block on every token.
 */
describe("the frame while the model is thinking", () => {
  it("draws the reasoning above the status row and keeps the prompt below both", () => {
    const frame = drawFrame({ thinkingTail: "reviso el gauge del compactador" });
    const rows = frame.trim().split("\n");

    expect(rows[0]).toContain("reviso el gauge del compactador");
    expect(rows.find((r) => r.includes("thinking · 47s"))).toBeDefined();
    expect(rows.at(-1)).toContain("pará, estás sobrepensando");
    // Order matters: the thinking reads as prose continuing from the conversation, with the
    // spinner underneath it as the "still working" anchor.
    expect(rows.findIndex((r) => r.includes("reviso el gauge"))).toBeLessThan(
      rows.findIndex((r) => r.includes("thinking · 47s")),
    );
  });

  it("frames the paragraph with an empty row on each side", () => {
    const rows = drawFrame({ thinkingTail: "reviso el gauge" }).split("\n");
    const first = rows.findIndex((r) => r.trimStart().startsWith("│ "));
    const last = rows.map((r) => r.trimStart().startsWith("│ ")).lastIndexOf(true);

    expect(first).toBeGreaterThan(0);
    expect(rows[first - 1].trim()).toBe("");
    expect(rows[last + 1].trim()).toBe("");
  });

  it("spends no rows on the frame when there is no paragraph", () => {
    // The blank rows belong to the block; with nothing being thought they would just be a hole
    // above the status line.
    const withThinking = drawFrame({ thinkingTail: "pensando" }).split("\n").length;
    const without = drawFrame({}).split("\n").length;
    expect(withThinking - without).toBe(3); // one row of text + the two that frame it
  });

  it("holds its height to the setting, so clearUI erases what was drawn", () => {
    const long = "palabra ".repeat(200);
    const rows = drawFrame({ thinkingTail: long }).trim().split("\n");
    const thinkingRows = rows.filter((r) => r.trimStart().startsWith("│ "));
    expect(thinkingRows.length).toBeLessThanOrEqual(4);
    expect(thinkingRows.length).toBeGreaterThan(1);
  });

  it("gives the rows back to the conversation when no turn is running", () => {
    // No active phase: the block belongs to what was said, not to a think that already ended.
    const rows = drawFrame({ thinkingTail: "algo viejo", activeStatus: undefined })
      .trim()
      .split("\n");
    expect(rows.some((r) => r.includes("algo viejo"))).toBe(false);
  });

  it("does not dim the reasoning into the background", () => {
    // It was italic AND dim, which put it at the weight of the label next to it: present on the
    // row, invisible on a real terminal.
    const raw = drawRaw({ thinkingTail: "reviso el gauge" });
    expect(raw).toContain("\x1b[3mreviso el gauge");
    expect(raw).not.toContain("\x1b[3;2m");
  });

  it("leaves an empty row between the indicators and the prompt", () => {
    // Status, context bar, role, artifacts and document stack up fast, and with the input welded
    // to the bottom of that pile the whole block read as a wall.
    const rows = drawFrame({ thinkingTail: "pensando", activeRole: "auditor" }).split("\n");
    const promptRow = rows.findIndex((r) => r.includes("pará, estás sobrepensando"));
    expect(promptRow).toBeGreaterThan(0);
    expect(rows[promptRow - 1].trim()).toBe("");
  });

  it("draws the same frame minus the tail when there is no reasoning to show", () => {
    const frame = drawFrame({});
    expect(frame).toContain("thinking · 47s");
    expect(frame).toContain("pará, estás sobrepensando");
  });
});
