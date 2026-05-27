import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ChatMessage, SessionMode } from './types.js';

export interface PersistedSession {
  version: 1;
  workspace: string;
  mode: SessionMode;
  createdAt: string;
  updatedAt: string;
  summary?: string;
  messages: ChatMessage[];
}

const SESSIONS_DIR = '.rei/sessions';
const CURRENT_FILE = 'current.json';

function sessionsDir(workspacePath: string): string {
  return path.join(workspacePath, SESSIONS_DIR);
}

function currentPath(workspacePath: string): string {
  return path.join(sessionsDir(workspacePath), CURRENT_FILE);
}

function ensureSessionsDir(workspacePath: string): void {
  fs.mkdirSync(sessionsDir(workspacePath), { recursive: true });
}

export function saveSession(
  workspacePath: string,
  messages: ChatMessage[],
  mode: SessionMode,
  summary?: string,
  existingCreatedAt?: string
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
  fs.writeFileSync(currentPath(workspacePath), JSON.stringify(data, null, 2), 'utf8');
}

export function loadCurrentSession(workspacePath: string): PersistedSession | null {
  try {
    const raw = fs.readFileSync(currentPath(workspacePath), 'utf8');
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
export function archiveCurrentSession(workspacePath: string, customName?: string): string | null {
  const src = currentPath(workspacePath);
  if (!fs.existsSync(src)) return null;

  try {
    const raw = fs.readFileSync(src, 'utf8');
    const data = JSON.parse(raw) as PersistedSession;
    
    let archiveName: string;
    if (customName) {
      const sanitized = customName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60);
      if (!sanitized) {
        const dateStr = (data.createdAt ?? new Date().toISOString()).slice(0, 10);
        const suffix = Date.now().toString(36).slice(-4);
        archiveName = `${dateStr}-${suffix}.json`;
      } else {
        archiveName = `${sanitized}.json`;
      }
    } else {
      const dateStr = (data.createdAt ?? new Date().toISOString()).slice(0, 10);
      const suffix = Date.now().toString(36).slice(-4);
      archiveName = `${dateStr}-${suffix}.json`;
    }

    const dest = path.join(sessionsDir(workspacePath), archiveName);
    
    // Handle collisions by appending a numeric suffix
    if (fs.existsSync(dest)) {
      const base = archiveName.replace(/\.json$/, '');
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

export interface SessionSummaryEntry {
  id: string;       // filename without .json
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
    if (!file.endsWith('.json') || file === CURRENT_FILE) continue;
    try {
      const raw = fs.readFileSync(path.join(dir, file), 'utf8');
      const data = JSON.parse(raw) as PersistedSession;
      const nonSystem = data.messages.filter((m) => m.role !== 'system');
      entries.push({
        id: file.replace(/\.json$/, ''),
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

export function loadSessionById(workspacePath: string, id: string): PersistedSession | null {
  const filePath = path.join(sessionsDir(workspacePath), `${id}.json`);
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const data = JSON.parse(raw) as PersistedSession;
    if (data.version !== 1 || !Array.isArray(data.messages)) return null;
    return data;
  } catch {
    return null;
  }
}
