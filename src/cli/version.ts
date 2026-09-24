import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

/**
 * Resolve files relative to THIS file (not cwd) so it works both in dev (`npm run dev`) and when
 * installed globally (`rei --version`).
 */
function repoRoot(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

let cachedVersion: string | null = null;

/** The package version alone — `0.1.0`. What everything used to show. */
export function getVersion(): string {
  if (cachedVersion !== null) return cachedVersion;
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot(), "package.json"), "utf-8"));
  cachedVersion = pkg.version ?? "0.0.0";
  return cachedVersion!;
}

interface BuildInfo {
  commit?: string | null;
  dirty?: boolean;
  builtAt?: string;
}

/** Written by scripts/write-build-info.js on every build. Absent on a tree that was never built. */
function readBuildInfo(): BuildInfo | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(repoRoot(), ".build-info.json"), "utf-8"));
  } catch {
    return null;
  }
}

/** `2026-09-19 12:39` — local time, minutes are enough to tell two builds apart. */
function formatBuiltAt(iso: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * The version line: `rei 0.1.0 (ed95a6a, 2026-09-19 12:39)`.
 *
 * The package version alone answers nothing when you run REI on two machines — it has not changed
 * in months, so a build from yesterday and one from today look identical, and finding out which is
 * which means grepping dist/ for a string you happen to remember. The commit does answer it.
 *
 * `+dirty` marks a build made with uncommitted edits: there the hash alone would misdescribe what
 * is actually running. Falls back to the bare version when `.build-info.json` is missing (a tree
 * that was never built) — an unknown build is reported as unknown, not guessed at.
 */
export function getVersionLine(): string {
  const version = getVersion();
  const info = readBuildInfo();
  if (!info?.commit) return version;

  const built = info.builtAt ? formatBuiltAt(info.builtAt) : null;
  const parts = [`${info.commit}${info.dirty ? "+dirty" : ""}`, built].filter(Boolean);
  return `${version} (${parts.join(", ")})`;
}
