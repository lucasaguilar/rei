import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { saveSession, archiveCurrentSession } from "./session-store.js";

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
