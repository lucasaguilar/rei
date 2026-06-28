import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { handleReadFiles, type ReadFilesContext } from "./read-files-handler.js";
import { createVirtualFileTree } from "./virtual-file-tree.js";

const fakeLogger = new Proxy({}, { get: () => vi.fn() }) as never;

describe("handleReadFiles", () => {
  let ws: string;
  let ctx: ReadFilesContext;

  beforeEach(() => {
    ws = fs.mkdtempSync(path.join(os.tmpdir(), "rei-readfiles-test-"));
    const tree = createVirtualFileTree(ws);
    ctx = {
      workspacePath: ws,
      logger: fakeLogger,
      emitStatus: () => {},
      toRel: tree.toRel,
      currentContent: tree.currentContent,
      virtualFiles: tree.virtualFiles,
      alreadyProvided: tree.alreadyProvided,
    };
  });
  afterEach(() => fs.rmSync(ws, { recursive: true, force: true }));

  it("returns disk content for a fresh file and records it as provided", async () => {
    fs.writeFileSync(path.join(ws, "a.ts"), "const a = 1;");
    const out = await handleReadFiles(["a.ts"], ctx);
    expect(out).toContain("const a = 1;");
    expect(ctx.alreadyProvided.get("a.ts")).toBe("const a = 1;");
  });

  it("dedups a re-read of an unchanged file (points back instead of re-dumping)", async () => {
    fs.writeFileSync(path.join(ws, "a.ts"), "const a = 1;");
    await handleReadFiles(["a.ts"], ctx); // first read records it
    const second = await handleReadFiles(["a.ts"], ctx);
    expect(second).toContain("unchanged since you last read it");
    expect(second).not.toContain("const a = 1;");
  });

  it("reflects pending virtual edits instead of stale disk", async () => {
    fs.writeFileSync(path.join(ws, "a.ts"), "old");
    ctx.virtualFiles.set("a.ts", "new pending content");
    const out = await handleReadFiles(["a.ts"], ctx);
    expect(out).toContain("new pending content");
    expect(out).not.toContain("old");
  });
});
