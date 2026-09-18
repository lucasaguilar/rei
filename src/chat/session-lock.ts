import * as fs from "node:fs";
import * as path from "node:path";
import {
  getActiveSessionId,
  renameActiveSession,
  sanitizeSessionName,
  sessionsDir,
  setActiveSession,
} from "./session-store.js";

/**
 * Per-session advisory lock (multi-session safety, see docs/multi-session-spec.md). When an instance
 * opens `sessions/<id>.json` it writes `sessions/<id>.lock` with its pid. A second instance opening the
 * SAME session detects the live lock and refuses (unless --force), instead of silently corrupting the
 * shared history via last-write-wins. A stale lock (holder process no longer alive) is stolen
 * automatically, so a crash never wedges a session.
 */

interface LockHolder {
  pid: number;
  startedAt: string;
}

export type LockResult =
  | { ok: true }
  | { ok: false; holderPid: number; startedAt: string };

function lockPath(workspacePath: string, id: string): string {
  return path.join(sessionsDir(workspacePath), `${id}.lock`);
}

function readLock(p: string): LockHolder | null {
  try {
    const data = JSON.parse(fs.readFileSync(p, "utf8")) as LockHolder;
    return typeof data.pid === "number" ? data : null;
  } catch {
    return null;
  }
}

/** True if a process with `pid` is currently running (signal 0 = existence check, doesn't kill). */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM = the process exists but isn't ours → still alive. ESRCH = no such process → dead.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Tries to lock session `id`. Succeeds when there's no lock, the existing lock is stale (dead holder),
 * or `force` is set (steal). Fails with the live holder's pid otherwise.
 */
export function acquireSessionLock(
  workspacePath: string,
  id: string,
  force = false,
): LockResult {
  const p = lockPath(workspacePath, id);
  fs.mkdirSync(sessionsDir(workspacePath), { recursive: true });

  if (fs.existsSync(p)) {
    const holder = readLock(p);
    if (
      holder &&
      holder.pid !== process.pid &&
      isProcessAlive(holder.pid) &&
      !force
    ) {
      return { ok: false, holderPid: holder.pid, startedAt: holder.startedAt };
    }
    // stale (dead holder), ours, or force → fall through and overwrite.
  }

  fs.writeFileSync(
    p,
    JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
    "utf8",
  );
  return { ok: true };
}

/**
 * Acquires the lock or prints a clear conflict message and returns false (git-style: refuse rather
 * than corrupt). Keeps the startup call site to one line.
 */
export function acquireOrWarn(
  workspacePath: string,
  id: string,
  force = false,
): boolean {
  const lock = acquireSessionLock(workspacePath, id, force);
  if (lock.ok) return true;
  console.error(
    `\n[REI] The actual session is already open in another terminal (PID ${lock.holderPid}, ` +
      `since ${lock.startedAt}).\n` +
      `       Options: 'rei -s <other-name>' · 'rei -c' (the last) · add '--force' to steal the lock.\n`,
  );
  return false;
}

/** Releases the lock for `id` — only if THIS process owns it (avoids deleting a stealer's lock). */
export function releaseSessionLock(workspacePath: string, id: string): void {
  const p = lockPath(workspacePath, id);
  try {
    const holder = readLock(p);
    if (holder?.pid === process.pid) fs.unlinkSync(p);
  } catch {
    // best-effort; a stale lock is harmless (auto-stolen next time)
  }
}

/**
 * Moves this instance's lock from the session it holds to `toId`, and binds it.
 *
 * The lock is taken once at startup, for whatever session the instance opened. Once a session can
 * change its own file mid-run — `/session save-as` renames it, `/session load` switches to another
 * one — that single acquisition stops describing reality: the instance would go on holding a lock
 * on a name it no longer writes to, while writing to a name nobody locked. Two terminals would then
 * share one history on last-write-wins, which is the exact corruption the lock exists to prevent.
 *
 * Refuses rather than steals when a live instance already holds `toId`, so switching into a session
 * someone has open fails the same way opening it from the shell does.
 */
export function bindToSession(
  workspacePath: string,
  toId: string,
  force = false,
): LockResult {
  const fromId = getActiveSessionId();
  if (fromId === toId) return { ok: true };

  const lock = acquireSessionLock(workspacePath, toId, force);
  if (!lock.ok) return lock;

  releaseSessionLock(workspacePath, fromId);
  setActiveSession(toId);
  return { ok: true };
}

export type ClaimNameResult =
  | { ok: true; id: string; previousId: string }
  | { ok: false; reason: "invalid" | "reserved" | "exists" }
  | { ok: false; reason: "locked"; holderPid: number; startedAt: string };

/**
 * `/session save-as`: takes the lock on the new name, renames the running session onto it, and
 * releases the old lock — in that order, so a failed rename never leaves a lock behind on a name
 * this instance does not own.
 */
export function claimSessionName(
  workspacePath: string,
  name: string,
  force = false,
): ClaimNameResult {
  const previousId = getActiveSessionId();
  const id = sanitizeSessionName(name);
  if (!id) return { ok: false, reason: "invalid" };
  if (id === previousId) return { ok: true, id, previousId };

  const lock = acquireSessionLock(workspacePath, id, force);
  if (!lock.ok) {
    return { ok: false, reason: "locked", holderPid: lock.holderPid, startedAt: lock.startedAt };
  }

  const renamed = renameActiveSession(workspacePath, name);
  if (!renamed.ok) {
    releaseSessionLock(workspacePath, id); // we never took this session — give the name back
    return renamed;
  }

  releaseSessionLock(workspacePath, previousId);
  return renamed;
}
