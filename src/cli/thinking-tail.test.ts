import { describe, it, expect, afterEach } from "vitest";
import {
  appendThinkingTail,
  formatThinkingBlock,
  resolveThinkingLines,
  DEFAULT_THINKING_LINES,
  THINKING_TAIL_MAX,
} from "./constants/chat.constants.js";

// eslint-disable-next-line no-control-regex
const plain = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");
const plainAll = (rows: string[]): string[] => rows.map(plain);

/**
 * The reasoning as a PARAGRAPH of drawn state, above the status row.
 *
 * Streaming the thinking to stdout cost the input prompt: every token erased the drawn block to
 * write, so the prompt was gone for the whole think and a keystroke landed in the middle of a
 * half-written sentence. As drawn state it repaints with the block and the prompt stays put — and
 * a fixed-height block can then afford to be several rows, which a stream never could.
 */
describe("appendThinkingTail", () => {
  it("flattens the reasoning to a single line", () => {
    const tail = appendThinkingTail(undefined, "primero leo\n\nel archivo\ty después");
    expect(tail).toBe("primero leo el archivo y después");
    expect(tail).not.toContain("\n");
  });

  it("keeps the END, which is the part that moves", () => {
    const tail = appendThinkingTail("x".repeat(THINKING_TAIL_MAX), "LO ÚLTIMO");
    expect(tail.length).toBe(THINKING_TAIL_MAX);
    expect(tail.endsWith("LO ÚLTIMO")).toBe(true);
  });

  it("accumulates across the token-by-token arrivals it is fed", () => {
    let tail = appendThinkingTail(undefined, "el usuario ");
    tail = appendThinkingTail(tail, "quiere que ");
    tail = appendThinkingTail(tail, "revise el gauge");
    expect(tail).toBe("el usuario quiere que revise el gauge");
  });
});

describe("formatThinkingBlock", () => {
  const TEXT =
    "primero reviso el gauge del compactador y después miro los tests que quedaron en rojo " +
    "para entender si el problema es la barra o la medición que la alimenta";

  it("returns the LAST rows, because that is where the model currently is", () => {
    const rows = plainAll(formatThinkingBlock(TEXT, 60, 2));
    expect(rows).toHaveLength(2);
    expect(rows.at(-1)).toContain("alimenta");
    expect(rows.join(" ")).not.toContain("primero reviso");
  });

  it("never draws more rows than it was given — the block height must be predictable", () => {
    // clearUI erases exactly as many rows as the last draw wrote; an extra row ghosts forever.
    for (const max of [1, 2, 3, 4, 8]) {
      expect(formatThinkingBlock(TEXT, 60, max).length).toBeLessThanOrEqual(max);
    }
  });

  it("wraps inside the terminal, gutter included", () => {
    for (const row of formatThinkingBlock(TEXT, 50, 4)) {
      expect(plain(row).length).toBeLessThanOrEqual(50);
    }
  });

  it("puts every row behind the same gutter, so the block reads as one region", () => {
    for (const row of formatThinkingBlock(TEXT, 60, 3)) {
      expect(plain(row).startsWith("│ ")).toBe(true);
    }
  });

  it("shows nothing when there is nothing being thought", () => {
    expect(formatThinkingBlock(undefined, 80, 4)).toEqual([]);
    expect(formatThinkingBlock("", 80, 4)).toEqual([]);
  });

  it("yields the rows to the prompt on a terminal too narrow to read anyway", () => {
    expect(formatThinkingBlock(TEXT, 18, 4)).toEqual([]);
  });
});

describe("resolveThinkingLines", () => {
  const saved = process.env.REI_THINKING_LINES;
  afterEach(() => {
    if (saved === undefined) delete process.env.REI_THINKING_LINES;
    else process.env.REI_THINKING_LINES = saved;
  });

  it("defaults to a paragraph", () => {
    delete process.env.REI_THINKING_LINES;
    expect(resolveThinkingLines()).toBe(DEFAULT_THINKING_LINES);
  });

  it("takes the setting, clamped to what a terminal can host", () => {
    process.env.REI_THINKING_LINES = "8";
    expect(resolveThinkingLines()).toBe(8);
    process.env.REI_THINKING_LINES = "0";
    expect(resolveThinkingLines()).toBe(1);
    process.env.REI_THINKING_LINES = "99";
    expect(resolveThinkingLines()).toBe(12);
  });

  it("ignores nonsense rather than drawing zero rows", () => {
    process.env.REI_THINKING_LINES = "muchas";
    expect(resolveThinkingLines()).toBe(DEFAULT_THINKING_LINES);
  });
});
