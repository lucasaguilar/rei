import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  handleEditFile,
  handleRewriteFile,
  handleCreateFile,
  type EditHandlerContext,
} from "./edit-handlers.js";
import { createVirtualFileTree } from "./virtual-file-tree.js";

const fakeLogger = new Proxy({}, { get: () => vi.fn() }) as never;

describe("edit handlers", () => {
  let ws: string;
  let ctx: EditHandlerContext;

  beforeEach(() => {
    ws = fs.mkdtempSync(path.join(os.tmpdir(), "rei-edit-test-"));
    const tree = createVirtualFileTree(ws);
    ctx = {
      workspacePath: ws,
      logger: fakeLogger,
      emitStatus: () => {},
      resolveTarget: tree.resolveTarget,
      editTasks: [],
      createdFiles: [],
    };
  });
  afterEach(() => fs.rmSync(ws, { recursive: true, force: true }));

  it("handleEditFile queues a search→replace edit", () => {
    const r = handleEditFile(
      { file: "a.ts", search: "x", replace: "y" },
      "c1",
      ctx,
    );
    expect(r).toEqual({});
    expect(ctx.editTasks).toEqual([{ callId: "c1", edit: { file: "a.ts", search: "x", replace: "y" } }]);
  });

  it("handleEditFile returns a precise error when search/replace is missing", () => {
    const r = handleEditFile({ file: "a.ts" }, "c1", ctx);
    expect(r.failed).toBe(true);
    expect(r.toolResult).toContain("search and replace");
    expect(ctx.editTasks).toEqual([]);
  });

  it("handleCreateFile writes a new file and records it", async () => {
    const r = await handleCreateFile({ file: "new.ts", content: "hi" }, ctx);
    expect(r.toolResult).toContain("created");
    expect(fs.readFileSync(path.join(ws, "new.ts"), "utf8")).toBe("hi");
    expect(ctx.createdFiles).toContain("new.ts");
  });

  it("handleCreateFile skips an existing file", async () => {
    fs.writeFileSync(path.join(ws, "exists.ts"), "old");
    const r = await handleCreateFile({ file: "exists.ts", content: "new" }, ctx);
    expect(r.toolResult).toContain("SKIPPED");
    expect(fs.readFileSync(path.join(ws, "exists.ts"), "utf8")).toBe("old");
  });

  it("handleRewriteFile queues a whole-file replace for an existing file", async () => {
    fs.writeFileSync(path.join(ws, "a.ts"), "old content");
    const r = await handleRewriteFile({ file: "a.ts", content: "brand new" }, "c1", ctx);
    expect(r).toEqual({});
    expect(ctx.editTasks[0]).toEqual({
      callId: "c1",
      edit: { file: "a.ts", search: "old content", replace: "brand new" },
      wholeFile: true,
    });
  });

  it("handleRewriteFile writes a new file directly when it doesn't exist", async () => {
    const r = await handleRewriteFile({ file: "fresh.ts", content: "data" }, "c1", ctx);
    expect(r.toolResult).toContain("created");
    expect(fs.readFileSync(path.join(ws, "fresh.ts"), "utf8")).toBe("data");
    expect(ctx.createdFiles).toContain("fresh.ts");
  });
});
