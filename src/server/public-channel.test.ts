import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createPublicChannel, isSlashCommand } from "./public-channel.js";
import type { ChatSession } from "../chat/types.js";

/**
 * The policy every public channel inherits (WhatsApp today, the web widget next). Pinned here,
 * independent of any transport, so a new channel cannot get a looser one by accident.
 */

let ws: string;
beforeEach(() => {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), "rei-public-channel-"));
});
afterEach(() => {
  fs.rmSync(ws, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

/** An agent that answers `reply`, records what each turn was given, and keeps the session. */
function mockAgent(reply = "ok") {
  const turns: Array<{ session: ChatSession; prompt: string; opts: any }> = [];
  return {
    turns,
    agent: {
      streamTurn: vi.fn(async function* (session: ChatSession, prompt: string, opts: any) {
        // A copy: the turn below appends to the live session.
        turns.push({ session: structuredClone(session), prompt, opts });
        session.messages.push({ role: "user", content: prompt });
        session.messages.push({ role: "assistant", content: reply });
        yield "\x10thinking that must not leak";
        yield `\x11${reply}`;
      }),
    } as any,
  };
}

const sessionFile = (id: string) => path.join(ws, ".rei", "sessions", `${id}.json`);

describe("createPublicChannel", () => {
  it("keeps one session per customer, named <prefix>-<key>", async () => {
    const { agent } = mockAgent();
    const channel = createPublicChannel(agent, ws, "web");

    await channel.turn("abc", "hola");
    await channel.turn("xyz", "hello");

    expect(fs.existsSync(sessionFile("web-abc"))).toBe(true);
    expect(fs.existsSync(sessionFile("web-xyz"))).toBe(true);
  });

  it("returns only the reply text, never the thinking", async () => {
    const { agent } = mockAgent("¡Hola!");
    expect(await createPublicChannel(agent, ws, "web").turn("abc", "hola")).toBe("¡Hola!");
  });

  it("resumes the customer's own history on the next message", async () => {
    const { agent, turns } = mockAgent();
    const channel = createPublicChannel(agent, ws, "web");

    await channel.turn("abc", "first");
    await channel.turn("abc", "second");

    expect(turns[1].session.messages.map((m) => m.content)).toEqual(["first", "ok"]);
  });

  it("forces ask mode even when the stored session says otherwise", async () => {
    fs.mkdirSync(path.dirname(sessionFile("web-abc")), { recursive: true });
    fs.writeFileSync(
      sessionFile("web-abc"),
      JSON.stringify({ version: 1, workspace: ws, mode: "agent", messages: [] }),
    );
    const { agent, turns } = mockAgent();

    await createPublicChannel(agent, ws, "web").turn("abc", "hola");

    expect(turns[0].session.mode).toBe("ask");
  });

  it("gives the turn only the read tools, scoped to the knowledge dir", async () => {
    vi.stubEnv("REI_WHATSAPP_KNOWLEDGE_DIR", "kb");
    const { agent, turns } = mockAgent();

    await createPublicChannel(agent, ws, "web").turn("abc", "hola");

    expect(turns[0].opts.allowedTools).toEqual(["read_files", "grep_code", "list_files"]);
    expect(turns[0].opts.readRoot).toBe(path.join(ws, "kb"));
  });

  it("runs one customer's tasks in order, and a failed one does not block the next", async () => {
    const { agent } = mockAgent();
    const channel = createPublicChannel(agent, ws, "web");
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));

    const first = channel.enqueue("abc", async () => {
      await gate;
      order.push("first");
      throw new Error("boom");
    });
    const second = channel.enqueue("abc", async () => void order.push("second"));
    release();

    await expect(first).rejects.toThrow("boom");
    await second;
    expect(order).toEqual(["first", "second"]);
  });
});

describe("isSlashCommand", () => {
  it("catches a command even behind leading whitespace", () => {
    expect(isSlashCommand("/mode agent")).toBe(true);
    expect(isSlashCommand("  /runplan")).toBe(true);
    expect(isSlashCommand("what does /etc hold?")).toBe(false);
  });
});
