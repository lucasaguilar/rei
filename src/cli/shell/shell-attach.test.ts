import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// The model turn itself is out of scope: what matters is the prompt it would receive.
const turns: Array<{ prompt: string; displayText?: string; note?: string }> = [];
vi.mock("../helpers/input-turn.helpers.js", () => ({
  handleInputTurn: vi.fn(
    async (prompt: string, _ctx: unknown, opts?: { displayText?: string; note?: string }) => {
      turns.push({ prompt, displayText: opts?.displayText, note: opts?.note });
    },
  ),
}));

const { InputHandler } = await import("../ui/input-handler.js");
const { buildRenderState } = await import("../helpers/render-state.helper.js");
import type { InputHandlerContext } from "../models/input-handler.types.js";
import type { ChatUIState } from "../models/chat.types.js";

const plain = (lines: string[]) => lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, "")).join("\n");

function makeCtx(ws: string) {
  const transcript: string[] = [];
  const state = {
    running: true,
    busy: false,
    inputBuffer: "",
    inputCursor: 0,
    inputHistory: [],
    selectedCommandIndex: 0,
    paletteClosed: true,
  } as unknown as ChatUIState;
  const ctx = {
    state,
    agent: {},
    session: { messages: [], mode: "agent" },
    transcript,
    workspacePath: ws,
    actions: {
      pushTranscript: (v: string) => transcript.push(...v.split("\n")),
      streamText: () => {},
      draw: () => {},
      startSpinner: () => {},
      stopSpinner: () => {},
      resetInput: () => {
        state.inputBuffer = "";
        state.inputCursor = 0;
      },
      rememberHistory: () => {},
      getActivePalette: () => ({ kind: "command", items: [] }),
      getMentionContext: () => undefined,
    },
  } as unknown as InputHandlerContext;
  const submit = async (text: string) => {
    state.inputBuffer = text;
    state.inputCursor = text.length;
    await InputHandler.submitInput(ctx);
  };
  return { ctx, state, transcript, submit };
}

describe("/attach — handing a !command's output to the model", () => {
  let ws: string;
  beforeEach(() => {
    ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rei-attach-")));
    turns.length = 0;
  });
  afterEach(() => fs.rmSync(ws, { recursive: true, force: true }));

  it("by default the output never reaches the model", async () => {
    const { submit, transcript } = makeCtx(ws);
    await submit("!echo MARKER-1");
    expect(plain(transcript)).toMatch(/\/attach/); // the footer says how to hand it over
    await submit("what failed?");
    expect(turns).toHaveLength(1);
    expect(turns[0].prompt).toBe("what failed?");
  });

  it("once attached, it rides on the next prompt only — as verified evidence", async () => {
    const { submit } = makeCtx(ws);
    await submit("!echo MARKER-2");
    await submit("/attach");
    await submit("what does it say?");
    await submit("and now?");

    expect(turns[0].prompt).toMatch(/^\[Verified/);
    expect(turns[0].prompt).toContain("$ echo MARKER-2");
    expect(turns[0].prompt).toContain("MARKER-2");
    expect(turns[0].prompt.endsWith("what does it say?")).toBe(true);
    // The transcript shows what YOU typed, not the evidence block.
    expect(turns[0].displayText).toBe("what does it say?");
    // Printed by the turn UNDER the "You:" label — pushed here it landed above it.
    expect(turns[0].note).toMatch(/sent with this message: \$ echo MARKER-2/);
    expect(turns[1].prompt).toBe("and now?");
  });

  it("shows a 🧾 indicator while something is attached, and not before", async () => {
    const { submit, state } = makeCtx(ws);
    const indicator = () =>
      buildRenderState({
        state,
        session: { messages: [], mode: "agent" } as never,
        palette: { kind: "command", items: [] },
        cols: 80,
        rows: 24,
      }).receiptIndicator;

    await submit("!echo hi");
    expect(indicator()).toBeUndefined();
    await submit("/attach");
    expect(indicator()).toMatch(/^🧾 echo hi \(exit 0/);
  });

  it("/detach drops it again", async () => {
    const { submit } = makeCtx(ws);
    await submit("!echo MARKER-3");
    await submit("/attach");
    await submit("/detach");
    await submit("hello");
    expect(turns[0].prompt).toBe("hello");
  });

  it("/attach with nothing to attach says so", async () => {
    const { submit, transcript } = makeCtx(ws);
    await submit("/attach");
    expect(plain(transcript)).toMatch(/nothing to attach/i);
    expect(turns).toHaveLength(0);
  });

  it("does not print the 'sent with' line itself, ahead of the user's label", async () => {
    const { submit, transcript } = makeCtx(ws);
    await submit("!echo MARKER-4");
    await submit("/attach");
    await submit("go");
    expect(plain(transcript)).not.toMatch(/sent with this message/);
  });

  it("attaches the LAST command: a new one replaces it, and says it did", async () => {
    const { submit, transcript } = makeCtx(ws);
    await submit("!echo FIRST");
    await submit("/attach");
    await submit("!echo SECOND");
    expect(plain(transcript)).toMatch(/no longer attached/i);
    await submit("/attach");
    await submit("go");
    expect(turns[0].prompt).toContain("SECOND");
    expect(turns[0].prompt).not.toContain("$ echo FIRST");
  });
});
