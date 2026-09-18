import * as fs from "node:fs";
import * as path from "node:path";
import type { ChatMessage, SessionMode } from "./types.js";

export interface PersistedSession {
  version: 1;
  workspace: string;
  mode: SessionMode;
  createdAt: string;
  updatedAt: string;
  summary?: string;
  messages: ChatMessage[];
}

const SESSIONS_DIR = ".rei/sessions";
const CURRENT_FILE = "current.json";

// The session file THIS instance reads/writes. Default `current.json` (retrocompat: the server and
// any caller that never sets it behave exactly as before). The CLI sets it per instance at startup
// (a fresh auto-id, a named session, or the most-recent one for -c), so N terminals don't collide.
// Module-level like setActiveModelTuning — avoids threading the id through ~10 saveSession call sites.
// See docs/multi-session-spec.md.
let activeSessionFile = CURRENT_FILE;

/** Binds this instance to session `<id>.json`. Call once at startup. */
export function setActiveSession(id: string): void {
  activeSessionFile = `${id}.json`;
}

/** The current instance's session id (filename without .json). */
export function getActiveSessionId(): string {
  return activeSessionFile.replace(/\.json$/, "");
}

/** A fresh timestamped session id (YYYY-MM-DD-HHMMSS) — same format as archived sessions. */
export function newSessionId(): string {
  const ts = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${ts.getFullYear()}-${pad(ts.getMonth() + 1)}-${pad(ts.getDate())}` +
    `-${pad(ts.getHours())}${pad(ts.getMinutes())}${pad(ts.getSeconds())}`
  );
}

/** The most recently updated session id, or null if there are none (for `rei -c`). */
export function mostRecentSessionId(workspacePath: string): string | null {
  const sessions = listSessions(workspacePath);
  return sessions.length ? sessions[0].id : null;
}

export function sessionsDir(workspacePath: string): string {
  return path.join(workspacePath, SESSIONS_DIR);
}

export function currentPath(workspacePath: string): string {
  return path.join(sessionsDir(workspacePath), activeSessionFile);
}

function ensureSessionsDir(workspacePath: string): void {
  fs.mkdirSync(sessionsDir(workspacePath), { recursive: true });
}

export function saveSession(
  workspacePath: string,
  messages: ChatMessage[],
  mode: SessionMode,
  summary?: string,
  existingCreatedAt?: string,
): void {
  ensureSessionsDir(workspacePath);
  const now = new Date().toISOString();
  const data: PersistedSession = {
    version: 1,
    workspace: workspacePath,
    mode,
    createdAt: existingCreatedAt ?? now,
    updatedAt: now,
    summary,
    messages,
  };
  fs.writeFileSync(
    currentPath(workspacePath),
    JSON.stringify(data, null, 2),
    "utf8",
  );
}

export function loadCurrentSession(
  workspacePath: string,
): PersistedSession | null {
  try {
    const raw = fs.readFileSync(currentPath(workspacePath), "utf8");
    const data = JSON.parse(raw) as PersistedSession;
    if (data.version !== 1 || !Array.isArray(data.messages)) return null;
    return data;
  } catch {
    return null;
  }
}

/**
 * Archives the current session to a dated file and removes current.json.
 * Optionally accepts a custom descriptive name for the archived file.
 */
export function archiveCurrentSession(
  workspacePath: string,
  customName?: string,
): string | null {
  const src = currentPath(workspacePath);
  if (!fs.existsSync(src)) return null;

  try {
    const raw = fs.readFileSync(src, "utf8");
    JSON.parse(raw); // validate it's a well-formed session before archiving

    // ALWAYS prefix with the archive timestamp (local YYYY-MM-DD-HHMMSS) so sessions stay
    // chronologically ordered, then append the optional custom name. Previously a custom
    // name REPLACED the date prefix (losing the ordering), and the no-name branch used the
    // session's createdAt — which is stale for long-lived sessions, so files showed the wrong
    // date. Using `now` (the moment of archiving) fixes both.
    const ts = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const prefix =
      `${ts.getFullYear()}-${pad(ts.getMonth() + 1)}-${pad(ts.getDate())}` +
      `-${pad(ts.getHours())}${pad(ts.getMinutes())}${pad(ts.getSeconds())}`;
    const sanitized = (customName ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60);
    const archiveName = sanitized
      ? `${prefix}-${sanitized}.json`
      : `${prefix}.json`;

    const dest = path.join(sessionsDir(workspacePath), archiveName);

    // Handle collisions by appending a numeric suffix
    if (fs.existsSync(dest)) {
      const base = archiveName.replace(/\.json$/, "");
      let counter = 1;
      let newName = `${base}-${counter}.json`;
      let newDest = path.join(sessionsDir(workspacePath), newName);
      while (fs.existsSync(newDest)) {
        counter++;
        newName = `${base}-${counter}.json`;
        newDest = path.join(sessionsDir(workspacePath), newName);
      }
      fs.renameSync(src, newDest);
      return newName;
    }

    fs.renameSync(src, dest);
    return archiveName;
  } catch {
    return null;
  }
}

/** Filesystem-safe session id from whatever the user typed. Empty when nothing survives. */
export function sanitizeSessionName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/\.json$/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

export type RenameActiveResult =
  | { ok: true; id: string; previousId: string }
  | { ok: false; reason: "invalid" | "reserved" | "exists" };

/**
 * Gives the RUNNING session a name and keeps writing to it — the "Save As" of a session.
 *
 * `/session archive` already names a session, but it names it on the way out: the file is dated,
 * sealed, and a new empty session takes its place. That is the wrong shape for the common case,
 * which is realising halfway through that the thing you are doing deserves a name and wanting to
 * carry on doing it.
 *
 * Nothing in memory moves, because nothing needs to: the session is the message array the CLI is
 * already holding, and this only changes which file `saveSession` writes it to. The rename is a
 * `fs.rename`, so the history written so far moves with it rather than being left behind in an
 * orphan file.
 */
export function renameActiveSession(
  workspacePath: string,
  name: string,
): RenameActiveResult {
  const id = sanitizeSessionName(name);
  if (!id) return { ok: false, reason: "invalid" };
  // `current.json` is the shared default file every non-CLI caller writes to; a session that
  // renamed itself onto it would be picked up by the next server run as its own.
  if (`${id}.json` === CURRENT_FILE) return { ok: false, reason: "reserved" };

  const previousId = getActiveSessionId();
  if (id === previousId) return { ok: true, id, previousId };

  const dest = path.join(sessionsDir(workspacePath), `${id}.json`);
  // Never overwrite: the file under that name is somebody's history, possibly a session open in
  // another terminal. The caller reports the clash and the user picks another name.
  if (fs.existsSync(dest)) return { ok: false, reason: "exists" };

  const src = currentPath(workspacePath);
  ensureSessionsDir(workspacePath);
  // No file yet means the session has not been saved once; there is nothing to move, and the
  // rebind below is enough — the next save lands on the new name.
  if (fs.existsSync(src)) fs.renameSync(src, dest);

  setActiveSession(id);
  return { ok: true, id, previousId };
}

export interface SessionSummaryEntry {
  id: string; // filename without .json
  createdAt: string;
  updatedAt: string;
  mode: SessionMode;
  turns: number;
  summary?: string;
}

export function listSessions(workspacePath: string): SessionSummaryEntry[] {
  const dir = sessionsDir(workspacePath);
  if (!fs.existsSync(dir)) return [];

  const entries: SessionSummaryEntry[] = [];
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith(".json") || file === CURRENT_FILE) continue;
    try {
      const raw = fs.readFileSync(path.join(dir, file), "utf8");
      const data = JSON.parse(raw) as PersistedSession;
      const nonSystem = data.messages.filter((m) => m.role !== "system");
      entries.push({
        id: file.replace(/\.json$/, ""),
        createdAt: data.createdAt,
        updatedAt: data.updatedAt,
        mode: data.mode,
        turns: Math.floor(nonSystem.length / 2),
        summary: data.summary,
      });
    } catch {
      // Corrupt file — skip
    }
  }

  return entries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/**
 * Resolves which session an instance uses at startup (multi-session, see docs/multi-session-spec.md)
 * and binds it via setActiveSession:
 *  - `name`     → `<name>.json` (resume it if it exists, else a fresh named one)
 *  - `continue` → the most recently updated session
 *  - default    → a BRAND-NEW session (own auto-id file), never colliding with other instances
 * Returns the loaded session, or null for a fresh one.
 */
export function resolveStartupSession(
  workspacePath: string,
  opts?: { name?: string; continue?: boolean },
): PersistedSession | null {
  if (opts?.name) {
    setActiveSession(opts.name);
    return loadCurrentSession(workspacePath);
  }
  if (opts?.continue) {
    const recent = mostRecentSessionId(workspacePath);
    if (recent) {
      setActiveSession(recent);
      return loadCurrentSession(workspacePath);
    }
  }
  setActiveSession(newSessionId());
  return null;
}

export function loadSessionById(
  workspacePath: string,
  id: string,
): PersistedSession | null {
  const filePath = path.join(sessionsDir(workspacePath), `${id}.json`);
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const data = JSON.parse(raw) as PersistedSession;
    if (data.version !== 1 || !Array.isArray(data.messages)) return null;
    return data;
  } catch {
    return null;
  }
}
