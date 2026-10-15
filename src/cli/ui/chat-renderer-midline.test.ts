import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatRenderer } from "./chat-renderer.js";
import type { ChatRendererState } from "../models/chat.types.js";

const COLS = 80;

/**
 * Just enough of a terminal to see what is left on screen: printable characters with autowrap at
 * the right edge, CR, LF, and the cursor/erase sequences the renderer uses. One cell per character
 * — the frames here carry one emoji, in the prompt, and nothing is measured to its right. The bug lives in how
 * many ROWS a write occupies, so asserting on the escape codes alone would not catch it.
 */
function screen(output: string): string[] {
  const rows: string[][] = [[]];
  let r = 0;
  let c = 0;
  const row = () => (rows[r] ??= []);
  // eslint-disable-next-line no-control-regex
  const tokens = output.match(/\x1b\[[0-9;?]*[a-zA-Z]|[\s\S]/gu) ?? [];
  for (const t of tokens) {
    const csi = /^\x1b\[([0-9;?]*)([a-zA-Z])$/.exec(t);
    if (csi) {
      const n = Number(csi[1]) || 1;
      if (csi[2] === "A") r = Math.max(0, r - n);
      else if (csi[2] === "B") r += n;
      else if (csi[2] === "G") c = n - 1;
      else if (csi[2] === "K") rows[r] = [];
      continue; // m (colour), h/l (cursor visibility)
    }
    if (t === "\r") c = 0;
    else if (t === "\n") {
      // A pty translates LF to CR LF (onlcr), so a bare "\n" from the app starts a fresh line.
      r += 1;
      c = 0;
    }
    else {
      if (c >= COLS) {
        r += 1;
        c = 0;
      }
      const line = row();
      while (line.length < c) line.push(" ");
      line[c] = t;
      c += 1;
    }
  }
  return rows.map((cells) => (cells ?? []).join("").trimEnd());
}

function frame(overrides: Partial<ChatRendererState> = {}): ChatRendererState {
  return {
    cols: COLS,
    rows: 24,
    activePalette: { kind: "command", items: [] },
    selectedCommandIndex: 0,
    historySearchMode: false,
    historySearchQuery: "",
    inputHistory: [],
    busy: true,
    activeStatus: "calling_model",
    statusStartedAt: Date.now(),
    spinnerIndex: 0,
    sessionMode: "agent",
    inputBuffer: "",
    inputCursor: 0,
    ...overrides,
  } as ChatRendererState;
}

let out: string[];

beforeEach(() => {
  out = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    out.push(String(chunk));
    return true;
  });
  ChatRenderer.resetDrawnState();
});

afterEach(() => vi.restoreAllMocks());

/** What run-chat's streamText does: erase the drawn block, then write the output. */
const stream = (value: string) => {
  ChatRenderer.clearUI();
  ChatRenderer.writeStream(value);
};

describe("output that stops mid-line while the spinner is drawn", () => {
  it("leaves no piece of the status line glued to the end of that line", () => {
    // The agent loop prints "- src/sum.ts: applied" with no newline, then re-arms the spinner.
    // The status row is padded to the full width, so drawn after 21 columns of text it wrapped
    // onto a second row that clearUI never counted — and "applied⠼ thinking · 0s" stayed behind.
    stream("1 patch(es) applied directly.\n- src/sum.ts: applied");
    ChatRenderer.draw(frame());
    ChatRenderer.draw(frame({ spinnerIndex: 1 })); // a spinner tick
    stream("\nFile: src/sum.ts\n");
    ChatRenderer.draw(frame({ activeStatus: undefined, busy: false }));

    const rows = screen(out.join(""));
    expect(rows.filter((r) => r.includes("thinking"))).toEqual([]);
    expect(rows).toContain("- src/sum.ts: applied");
    expect(rows[rows.indexOf("- src/sum.ts: applied") + 1]).toBe("File: src/sum.ts");
  });

  it("lets the line carry on where it stopped once the block is erased", () => {
    stream("Running: npm");
    ChatRenderer.draw(frame());
    stream(" test\n");
    ChatRenderer.draw(frame({ activeStatus: undefined, busy: false }));

    expect(screen(out.join(""))).toContain("Running: npm test");
  });
});
