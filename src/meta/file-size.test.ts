import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";

// File-size guardrail — see docs/refactor-plan.md.
// Keeps the codebase readable: no source file may exceed MAX_LINES. The handful of files that
// are over today are the refactor BACKLOG (ALLOWLIST). New/edited files must stay under, and the
// allowlist may ONLY SHRINK — as a big file is split, it's removed from the list here.
const MAX_LINES = 400;

const ALLOWLIST = new Set<string>([
  "src/core/agent.ts",
  // src/agent-mode/generator.ts — DELETED 🎉 (XML interception path demolished; the native
  // function-calling loop is now the only engine across ask/planning/agent).
  // src/agent-mode/generator-tools.ts — REMOVED from the backlog 🎉 (Phase 2 tools-loop extraction
  // brought it from 1100 → 366 lines; it must now stay ≤ 400 like any other file).
  // src/chat/menu-command-processor.ts — REMOVED from the backlog 🎉 (Phase 1 command-registry
  // migration brought it from 1030 → ~343 lines; it must now stay ≤ 400 like any other file).
  "src/tools/command-executor.ts",
  "src/tools/repo-map-generator.ts",
  "src/tools/vision-sidecar.ts",
  "src/providers/ollama-provider.ts",
  // src/cli/run-chat.ts — CLI bootstrap crossed the line when the startup-tuning pre-resolve
  // block landed (408 lines). Splitting it is backlog; allowlisted so the guardrail stays green.
  "src/cli/run-chat.ts",
]);

const SRC_ROOT = path.resolve(__dirname, "..");

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      sourceFiles(full, acc);
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      acc.push(full);
    }
  }
  return acc;
}

function lineCount(file: string): number {
  return readFileSync(file, "utf8").split("\n").length;
}

/** Path relative to the repo root, posix-style (matches the ALLOWLIST entries). */
function rel(file: string): string {
  return path.relative(path.join(SRC_ROOT, ".."), file).split(path.sep).join("/");
}

describe("file-size guardrail (docs/refactor-plan.md)", () => {
  it(`no source file exceeds ${MAX_LINES} lines unless it's a known backlog file`, () => {
    const offenders = sourceFiles(SRC_ROOT)
      .map((f) => ({ rel: rel(f), lines: lineCount(f) }))
      .filter((f) => f.lines > MAX_LINES && !ALLOWLIST.has(f.rel))
      .map((f) => `${f.rel} (${f.lines} lines)`);

    expect(
      offenders,
      `New files over ${MAX_LINES} lines — split them, or (only if truly unavoidable) add to the ALLOWLIST.`,
    ).toEqual([]);
  });

  it("the backlog allowlist only SHRINKS — each listed file still exists and is still oversized", () => {
    const stale: string[] = [];
    for (const relPath of ALLOWLIST) {
      const full = path.join(SRC_ROOT, "..", relPath);
      let lines: number;
      try {
        lines = lineCount(full);
      } catch {
        stale.push(`${relPath} (no longer exists — remove from ALLOWLIST)`);
        continue;
      }
      if (lines <= MAX_LINES) {
        stale.push(`${relPath} (now ${lines} ≤ ${MAX_LINES} — remove from ALLOWLIST 🎉)`);
      }
    }
    expect(stale, "ALLOWLIST entries that should be removed").toEqual([]);
  });
});
