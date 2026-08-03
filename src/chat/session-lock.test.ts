import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  acquireSessionLock,
  releaseSessionLock,
  acquireOrWarn,
} from "./session-lock.js";

describe("session-lock", () => {
  let ws: string;
  const lockFile = (id: string) => path.join(ws, ".rei/sessions", `${id}.lock`);

  beforeEach(() => {
    ws = fs.mkdtempSync(path.join(os.tmpdir(), "rei-lock-"));
  });
  afterEach(() => fs.rmSync(ws, { recursive: true, force: true }));

  it("acquires a free session and writes a lock with our pid", () => {
    expect(acquireSessionLock(ws, "feature")).toEqual({ ok: true });
    const held = JSON.parse(fs.readFileSync(lockFile("feature"), "utf8"));
    expect(held.pid).toBe(process.pid);
  });

  it("re-acquiring our own lock succeeds (same pid)", () => {
    acquireSessionLock(ws, "feature");
    expect(acquireSessionLock(ws, "feature")).toEqual({ ok: true });
  });

  it("refuses a session held live by another process", () => {
    // Write a lock owned by a definitely-alive process that isn't us: pid 1 (init).
    fs.mkdirSync(path.join(ws, ".rei/sessions"), { recursive: true });
    fs.writeFileSync(lockFile("busy"), JSON.stringify({ pid: 1, startedAt: "x" }));
    const r = acquireSessionLock(ws, "busy");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.holderPid).toBe(1);
  });

  it("steals a STALE lock (dead holder pid)", () => {
    fs.mkdirSync(path.join(ws, ".rei/sessions"), { recursive: true });
    // pid 999999999 is not a running process → stale → should be stolen.
    fs.writeFileSync(lockFile("stale"), JSON.stringify({ pid: 999999999, startedAt: "x" }));
    expect(acquireSessionLock(ws, "stale")).toEqual({ ok: true });
    expect(JSON.parse(fs.readFileSync(lockFile("stale"), "utf8")).pid).toBe(process.pid);
  });

  it("force steals a live lock", () => {
    fs.mkdirSync(path.join(ws, ".rei/sessions"), { recursive: true });
    fs.writeFileSync(lockFile("busy"), JSON.stringify({ pid: 1, startedAt: "x" }));
    expect(acquireSessionLock(ws, "busy", true)).toEqual({ ok: true });
  });

  it("release removes only our own lock, then it's re-acquirable", () => {
    acquireSessionLock(ws, "feature");
    releaseSessionLock(ws, "feature");
    expect(fs.existsSync(lockFile("feature"))).toBe(false);
    expect(acquireSessionLock(ws, "feature")).toEqual({ ok: true });
  });

  it("release does NOT delete a lock owned by another process", () => {
    fs.mkdirSync(path.join(ws, ".rei/sessions"), { recursive: true });
    fs.writeFileSync(lockFile("busy"), JSON.stringify({ pid: 1, startedAt: "x" }));
    releaseSessionLock(ws, "busy");
    expect(fs.existsSync(lockFile("busy"))).toBe(true); // not ours → untouched
  });

  it("acquireOrWarn returns true on success, false on a live conflict", () => {
    expect(acquireOrWarn(ws, "ok")).toBe(true);
    fs.writeFileSync(lockFile("busy"), JSON.stringify({ pid: 1, startedAt: "x" }));
    expect(acquireOrWarn(ws, "busy")).toBe(false);
    expect(acquireOrWarn(ws, "busy", true)).toBe(true); // --force
  });
});
