import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * A guardrail for the defect class this repo keeps producing: code that is DECLARED and never
 * ENFORCED.
 *
 * Five instances turned up in a single session — `SENSITIVE_FILE_NAMES`, `modelFeedback`,
 * `DEFAULT_FILE_MODIFY_POLICY`, a role's `writeGlob`/`preferredModel`, and role permissions inside
 * sub-agents. Every one read as a working feature: the field was in the file, the docs described
 * it, nothing errored. That is exactly why they survived — and why a user trusting `writeGlob` to
 * keep an agent out of their source was trusting a comment.
 *
 * The audit that followed also found 332 lines across six files that NOTHING imports, including a
 * constants module declaring four retry policies no code applies — leftovers from the XML path's
 * removal, still readable as live policy.
 *
 * This test cannot prove a declared thing is honoured. It proves the weaker, cheap property that
 * catches the same class: a module nothing imports cannot be enforcing anything.
 */

const SRC = path.resolve(__dirname, "..");

/**
 * Files reached by something other than an import, so an importer count of zero is expected.
 * Every entry names WHY, because an unexplained entry here is how a guardrail rots into a
 * list of things somebody once wanted to stop thinking about.
 */
const NOT_IMPORTED_ON_PURPOSE: Record<string, string> = {
  "main.ts": "CLI entry point — `tsx src/main.ts` / `node dist/main.js`",
  "server.ts": "server entry point — `npm run server`",
  "load-env.ts": "side-effect import, first line of main.ts and server.ts",
  "context/rag/rag-worker.ts": "worker thread, spawned by URL from rag-indexer.ts",
  "types/emscripten.d.ts": "ambient type declarations",
};

const walk = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : [];
  });

const rel = (f: string) => path.relative(SRC, f).split(path.sep).join("/");

const all = walk(SRC);
const sources = all.filter((f) => !f.endsWith(".test.ts"));
const bodies = new Map(all.map((f) => [f, fs.readFileSync(f, "utf-8")]));

/** Every source file some other file imports, resolved through the .js → .ts extension swap. */
const importedFiles = new Set<string>();
for (const [file, body] of bodies) {
  for (const m of body.matchAll(/from\s+"([^"]+)"|import\s*\(\s*"([^"]+)"\s*\)/g)) {
    const spec = m[1] ?? m[2];
    if (!spec?.startsWith(".")) continue;
    const base = path.resolve(path.dirname(file), spec);
    for (const cand of [base.replace(/\.js$/, ".ts"), `${base}.ts`, path.join(base, "index.ts")]) {
      if (bodies.has(cand)) {
        importedFiles.add(cand);
        break;
      }
    }
  }
}

describe("no source file is dead", () => {
  it("every module is imported by something, or explains why it is not", () => {
    const orphans = sources
      .filter((f) => !importedFiles.has(f))
      .map(rel)
      .filter((r) => !(r in NOT_IMPORTED_ON_PURPOSE) && !r.endsWith("index.ts"))
      .sort();

    expect(
      orphans,
      "Modules nothing imports. Delete them, wire them up, or add an entry to " +
        "NOT_IMPORTED_ON_PURPOSE saying how they are reached. A module nobody imports " +
        "declares policy it cannot enforce.",
    ).toEqual([]);
  });

  it("keeps the exemption list honest — every entry still exists", () => {
    // An exemption for a deleted file is a stale excuse that would silently cover a future orphan
    // of the same name.
    for (const f of Object.keys(NOT_IMPORTED_ON_PURPOSE)) {
      expect(fs.existsSync(path.join(SRC, f)), `${f} is exempted but does not exist`).toBe(true);
    }
  });

  it("exempts entry points only, not ordinary modules", () => {
    expect(Object.keys(NOT_IMPORTED_ON_PURPOSE).length).toBeLessThanOrEqual(8);
  });
});
