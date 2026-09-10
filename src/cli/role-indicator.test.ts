import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ChatRenderer } from "./ui/chat-renderer.js";
import type { ChatRendererState } from "./models/chat.types.js";

// Strips ALL CSI sequences, not just colours: the draw also writes cursor moves (\x1b[41G) and
// show/hide, which would otherwise count toward a line's width in the clipping check below.
// eslint-disable-next-line no-control-regex
const plain = (s: string): string => s.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");

let written: string[] = [];
beforeEach(() => {
  written = [];
  vi.spyOn(process.stdout, "write").mockImplementation((c: unknown) => {
    written.push(String(c));
    return true;
  });
  ChatRenderer.resetDrawnState();
});
afterEach(() => vi.restoreAllMocks());

const draw = (over: Partial<ChatRendererState> = {}): string => {
  ChatRenderer.resetDrawnState();
  ChatRenderer.draw({
    cols: 100,
    rows: 24,
    inputBuffer: "",
    inputCursor: 0,
    sessionMode: "planning",
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

/**
 * A role adopts its own baseMode, write scope and preferred model. The prompt then reads `plan »`
 * with nothing saying WHY — and a role you forgot about is a session quietly running under
 * someone else's rules, including a narrowed write scope that will refuse an edit for no visible
 * reason.
 */
describe("the active role is visible in the sticky block", () => {
  it("shows the role that is active", () => {
    expect(draw({ activeRole: "auditor" })).toContain("🎭 auditor");
  });

  it("shows nothing when no role is active", () => {
    expect(draw()).not.toContain("🎭");
  });

  it("shows the role and the active document together", () => {
    const out = draw({ activeRole: "auditor", activeDocument: "docs/plan.md" });
    expect(out).toContain("🎭 auditor");
    expect(out).toContain("📄 plan.md");
  });

  it("sits above the prompt, so the input row stays the last one", () => {
    const out = draw({ activeRole: "auditor" });
    expect(out.indexOf("🎭")).toBeLessThan(out.indexOf("»"));
  });

  it("clips to the terminal width like every other fixed line", () => {
    // lastDrawnLinesCount counts logical lines while clearUI erases terminal ROWS: a line that
    // wraps leaves a row behind on every redraw.
    const out = draw({ activeRole: "x".repeat(200), cols: 40 });
    for (const line of out.split("\r\n")) expect(line.length).toBeLessThanOrEqual(40);
  });
});
