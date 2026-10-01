import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type * as readline from "readline";
import { parseShellEscape } from "./shell-escape.js";
import { InputHandler } from "../ui/input-handler.js";
import { KeyboardHandler } from "../ui/keyboard-handler.js";
import type { InputHandlerContext } from "../models/input-handler.types.js";
import type { ChatUIState, KeyboardActions } from "../models/chat.types.js";

// ANSI color codes would make every assertion about the transcript brittle.
const plain = (lines: string[]) => lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""));

function makeCtx(ws: string, inputBuffer: string, busy = false) {
  const transcript: string[] = [];
  const state = {
    running: true,
    busy,
    inputBuffer,
    inputCursor: inputBuffer.length,
    inputHistory: [],
    selectedCommandIndex: 0,
    paletteClosed: true,
  } as unknown as ChatUIState;
  // Any touch of the agent means the command reached the model — which is exactly the bug.
  const agent = new Proxy(
    {},
    {
      get(_t, prop) {
        throw new Error(`the agent was used (${String(prop)}) by a shell escape`);
      },
    },
  );
  const session = { messages: [], mode: "agent" };
  const ctx = {
    state,
    agent,
    session,
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
  return { ctx, transcript, state, session };
}

describe("parseShellEscape", () => {
  it("takes the command after a leading !", () => {
    expect(parseShellEscape("!git status")).toBe("git status");
    expect(parseShellEscape("!  ls -la ")).toBe("ls -la");
    expect(parseShellEscape("!")).toBe("");
  });

  it("leaves everything else to the normal paths", () => {
    expect(parseShellEscape("why does !x fail?")).toBeNull();
    expect(parseShellEscape("/mode ask")).toBeNull();
  });
});

describe("! shell escape from the prompt", () => {
  let ws: string;
  beforeEach(() => {
    ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rei-escape-")));
  });
  afterEach(() => fs.rmSync(ws, { recursive: true, force: true }));

  it("runs the command in the workspace and never reaches the model", async () => {
    fs.writeFileSync(path.join(ws, "marker.txt"), "");
    const { ctx, transcript, session } = makeCtx(ws, "!ls");

    await InputHandler.submitInput(ctx);

    const out = plain(transcript);
    expect(out).toContain("$ ls");
    expect(out).toContain("marker.txt");
    expect(out.some((l) => /exit 0/.test(l) && /not sent to the model/.test(l))).toBe(true);
    expect(session.messages).toEqual([]);
  });

  it("reports a failing command's exit code", async () => {
    const { ctx, transcript } = makeCtx(ws, "!exit 7");
    await InputHandler.submitInput(ctx);
    expect(plain(transcript).some((l) => /exit 7/.test(l))).toBe(true);
  });

  it("a bare ! runs nothing and says how to use it", async () => {
    const { ctx, transcript } = makeCtx(ws, "!");
    await InputHandler.submitInput(ctx);
    expect(plain(transcript).join("\n")).toMatch(/!git status/);
  });

  it("while a turn runs, !cmd is refused — not queued as a message for the model", async () => {
    const { ctx, transcript, state } = makeCtx(ws, "!ls", true);
    await InputHandler.submitInput(ctx);
    expect(state.queuedUserMessages ?? []).toEqual([]);
    expect(plain(transcript).join("\n")).toMatch(/shell command/i);
  });
});

describe("Ctrl+C during a shell escape", () => {
  it("stops the command and keeps REI running", () => {
    let aborted = false;
    const state = { running: true, shellAbort: () => (aborted = true) } as unknown as ChatUIState;
    KeyboardHandler.handleKeypress(
      "\x03",
      { ctrl: true, name: "c" } as readline.Key,
      state,
      {} as KeyboardActions,
    );
    expect(aborted).toBe(true);
    expect(state.running).toBe(true);
  });
});

describe("the escape stays CLI-only", () => {
  it("nothing the HTTP server loads imports it", () => {
    // It runs the USER's command with no allow-list; reachable from server.ts (and so WhatsApp)
    // it would be remote command execution for anyone who can POST.
    const src = path.resolve(__dirname, "../..");
    const serverFiles = [
      path.join(src, "server.ts"),
      ...fs.readdirSync(path.join(src, "server")).map((f) => path.join(src, "server", f)),
      ...fs.readdirSync(path.join(src, "chat"), { recursive: true })
        .map((f) => path.join(src, "chat", String(f)))
        .filter((f) => f.endsWith(".ts")),
    ];
    const importers = serverFiles.filter((f) =>
      /cli\/shell\//.test(fs.readFileSync(f, "utf8")),
    );
    expect(importers).toEqual([]);
  });
});
