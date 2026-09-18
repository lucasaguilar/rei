import { describe, expect, it, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  getActiveSessionId,
  loadCurrentSession,
  renameActiveSession,
  saveSession,
  setActiveSession,
  listSessions,
} from "./session-store.js";
import type { ChatMessage } from "./types.js";

/**
 * `/session save-as` has to do the thing the name promises and nothing else: the session gets a
 * name and CARRIES ON. The failure that matters is not a bad file name — it is a save-as that
 * quietly ends the session, or one that leaves the history behind in the old file.
 */
describe("renameActiveSession", () => {
  let ws: string;

  const messages: ChatMessage[] = [
    { role: "user", content: "hola" },
    { role: "assistant", content: "hola" },
  ];

  beforeEach(() => {
    ws = fs.mkdtempSync(path.join(os.tmpdir(), "rei-saveas-"));
    setActiveSession("2026-09-18-120000");
    saveSession(ws, messages, "agent");
  });

  afterEach(() => {
    fs.rmSync(ws, { recursive: true, force: true });
    setActiveSession("current");
  });

  it("moves the history to the new name and keeps writing there", () => {
    const result = renameActiveSession(ws, "Fix The Context Bug");
    expect(result).toMatchObject({ ok: true, id: "fix-the-context-bug" });

    // The session did not end: it is still the active one, and its history came along.
    expect(getActiveSessionId()).toBe("fix-the-context-bug");
    expect(loadCurrentSession(ws)?.messages).toHaveLength(2);

    // And the old file is gone rather than orphaned with a copy of the history.
    expect(fs.existsSync(path.join(ws, ".rei/sessions/2026-09-18-120000.json"))).toBe(false);

    // A later turn lands in the named file, not the old one.
    saveSession(ws, [...messages, { role: "user", content: "seguimos" }], "agent");
    expect(loadCurrentSession(ws)?.messages).toHaveLength(3);
    expect(listSessions(ws).map((s) => s.id)).toEqual(["fix-the-context-bug"]);
  });

  it("refuses to overwrite an existing session", () => {
    fs.writeFileSync(path.join(ws, ".rei/sessions/taken.json"), "{}");
    expect(renameActiveSession(ws, "taken")).toEqual({ ok: false, reason: "exists" });
    // The active session is untouched by the refusal.
    expect(getActiveSessionId()).toBe("2026-09-18-120000");
  });

  it("refuses the reserved default file and names that sanitise to nothing", () => {
    expect(renameActiveSession(ws, "current")).toEqual({ ok: false, reason: "reserved" });
    expect(renameActiveSession(ws, "!!!")).toEqual({ ok: false, reason: "invalid" });
  });

  it("is a no-op when the session already has that name", () => {
    renameActiveSession(ws, "keeper");
    expect(renameActiveSession(ws, "keeper")).toMatchObject({ ok: true, id: "keeper" });
    expect(loadCurrentSession(ws)?.messages).toHaveLength(2);
  });
});
