import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { applyEditBatch, type BatchContext } from "./apply-edit-batch.js";
import { createVirtualFileTree } from "./virtual-file-tree.js";
import type { EditTask } from "./edit-handlers.js";

const fakeLogger = new Proxy({}, { get: () => vi.fn() }) as never;

describe("applyEditBatch (direct mode)", () => {
  let ws: string;
  let ctx: BatchContext;

  beforeEach(() => {
    ws = fs.mkdtempSync(path.join(os.tmpdir(), "rei-batch-test-"));
    const tree = createVirtualFileTree(ws);
    ctx = {
      workspacePath: ws,
      loopCount: 1,
      directMode: true,
      mismatchStreak: 0,
      injectAt: 2,
      wholefileAt: 4,
      logger: fakeLogger,
      virtualFiles: tree.virtualFiles,
      toolResultsMap: new Map(),
      readDisk: tree.readDisk,
      persistToDisk: tree.persistToDisk,
    };
  });
  afterEach(() => fs.rmSync(ws, { recursive: true, force: true }));

  const task = (file: string, search: string, replace: string): EditTask => ({
    callId: `c_${file}`,
    edit: { file, search, replace },
  });

  it("returns a no-op for an empty batch", async () => {
    const r = await applyEditBatch([], ctx);
    expect(r).toEqual({ failed: false, mismatchStreak: 0, mismatchEscalation: null });
  });

  it("applies an edit to disk and reports success", async () => {
    fs.writeFileSync(path.join(ws, "a.ts"), "const x = 1;");
    const r = await applyEditBatch([task("a.ts", "const x = 1;", "const x = 2;")], ctx);
    expect(r.failed).toBe(false);
    expect(fs.readFileSync(path.join(ws, "a.ts"), "utf8")).toBe("const x = 2;");
    expect(ctx.toolResultsMap.get("c_a.ts")).toContain("applied");
  });

  it("flags a search mismatch: ERROR fed back, file untouched, streak bumped", async () => {
    fs.writeFileSync(path.join(ws, "a.ts"), "const x = 1;");
    const r = await applyEditBatch([task("a.ts", "NOT PRESENT", "y")], ctx);
    expect(r.failed).toBe(true);
    expect(r.mismatchStreak).toBe(1);
    expect(fs.readFileSync(path.join(ws, "a.ts"), "utf8")).toBe("const x = 1;");
    expect(ctx.toolResultsMap.get("c_a.ts")).toMatch(/^ERROR:/);
  });

  it("escalates to 'inject' at the inject tier", async () => {
    fs.writeFileSync(path.join(ws, "a.ts"), "x");
    ctx.mismatchStreak = 1; // next failure → streak 2 === injectAt
    const r = await applyEditBatch([task("a.ts", "NOPE", "y")], ctx);
    expect(r.mismatchStreak).toBe(2);
    expect(r.mismatchEscalation).toEqual({ files: ["a.ts"], mode: "inject" });
  });
});
