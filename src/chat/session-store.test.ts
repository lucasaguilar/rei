import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  saveSession,
  archiveCurrentSession,
  setActiveSession,
  newSessionId,
  mostRecentSessionId,
  loadCurrentSession,
  listSessions,
} from "./session-store.js";

describe("archiveCurrentSession naming", () => {
  let ws: string;
  beforeEach(() => {
    ws = fs.mkdtempSync(path.join(os.tmpdir(), "rei-sess-test-"));
  });
  afterEach(() => {
    fs.rmSync(ws, { recursive: true, force: true });
  });

  const seed = () =>
    saveSession(ws, [{ role: "user", content: "hi" }], "agent", undefined);

  // YYYY-MM-DD-HHMMSS
  const PREFIX = /^\d{4}-\d{2}-\d{2}-\d{6}/;

  it("always prefixes with a YYYY-MM-DD-HHMMSS timestamp (no name)", () => {
    seed();
    const name = archiveCurrentSession(ws)!;
    expect(name).toMatch(PREFIX);
    expect(name).toMatch(/^\d{4}-\d{2}-\d{2}-\d{6}\.json$/);
  });

  it("keeps the timestamp prefix AND appends the custom name", () => {
    seed();
    const name = archiveCurrentSession(ws, "My Cool Session!")!;
    expect(name).toMatch(PREFIX);
    expect(name).toMatch(/-my-cool-session\.json$/);
  });

  it("uses the archive time (now), not the session's stale createdAt", () => {
    // Session created long ago (May), archived now → prefix must reflect NOW, not May.
    saveSession(ws, [{ role: "user", content: "x" }], "agent", undefined, "2026-05-27T16:38:13.193Z");
    const name = archiveCurrentSession(ws)!;
    const yearMonth = name.slice(0, 7);
    const nowYM = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, "0")}`;
    expect(yearMonth).toBe(nowYM);
    expect(name.startsWith("2026-05")).toBe(false);
  });

  it("removes current.json after archiving", () => {
    seed();
    archiveCurrentSession(ws);
    expect(fs.existsSync(path.join(ws, ".rei", "sessions", "current.json"))).toBe(false);
  });

  it("returns null when there is no current session", () => {
    expect(archiveCurrentSession(ws)).toBeNull();
  });
});

describe("multi-session (setActiveSession / newSessionId / mostRecentSessionId)", () => {
  let ws: string;
  beforeEach(() => {
    ws = fs.mkdtempSync(path.join(os.tmpdir(), "rei-multi-sess-"));
  });
  afterEach(() => {
    fs.rmSync(ws, { recursive: true, force: true });
    setActiveSession("current"); // reset the module-level active file for other tests
  });

  it("newSessionId is a YYYY-MM-DD-HHMMSS timestamp", () => {
    expect(newSessionId()).toMatch(/^\d{4}-\d{2}-\d{2}-\d{6}$/);
  });

  it("saveSession writes to the ACTIVE session file, not current.json", () => {
    setActiveSession("feature-x");
    saveSession(ws, [{ role: "user", content: "hi" }], "agent");
    expect(fs.existsSync(path.join(ws, ".rei/sessions/feature-x.json"))).toBe(true);
    expect(fs.existsSync(path.join(ws, ".rei/sessions/current.json"))).toBe(false);
  });

  it("two named sessions are independent files (no collision)", () => {
    setActiveSession("frontend");
    saveSession(ws, [{ role: "user", content: "front" }], "ask");
    setActiveSession("backend");
    saveSession(ws, [{ role: "user", content: "back" }], "ask");
    setActiveSession("frontend");
    expect(loadCurrentSession(ws)?.messages[0].content).toBe("front");
    setActiveSession("backend");
    expect(loadCurrentSession(ws)?.messages[0].content).toBe("back");
    expect(listSessions(ws).map((s) => s.id).sort()).toEqual(["backend", "frontend"]);
  });

  it("mostRecentSessionId returns the latest by updatedAt (for `rei -c`)", async () => {
    setActiveSession("older");
    saveSession(ws, [{ role: "user", content: "a" }], "ask");
    await new Promise((r) => setTimeout(r, 10));
    setActiveSession("newer");
    saveSession(ws, [{ role: "user", content: "b" }], "ask");
    expect(mostRecentSessionId(ws)).toBe("newer");
  });

  it("mostRecentSessionId is null when there are no sessions", () => {
    expect(mostRecentSessionId(ws)).toBeNull();
  });
});
