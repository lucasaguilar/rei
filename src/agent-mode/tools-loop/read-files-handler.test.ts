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
    };
  });
  afterEach(() => fs.rmSync(ws, { recursive: true, force: true }));

  it("returns full disk content and is never allUnchanged", async () => {
    fs.writeFileSync(path.join(ws, "a.ts"), "const a = 1;");
    const out = await handleReadFiles(["a.ts"], ctx);
    expect(out.text).toContain("const a = 1;");
    expect(out.allUnchanged).toBe(false);
  });

  it("always serves the file on re-read (no dedup guard)", async () => {
    fs.writeFileSync(path.join(ws, "a.ts"), "const a = 1;");
    await handleReadFiles(["a.ts"], ctx);
    const second = await handleReadFiles(["a.ts"], ctx);
    expect(second.text).toContain("const a = 1;");
    expect(second.text).not.toContain("ALREADY have the full content");
    expect(second.allUnchanged).toBe(false);
  });

  it("is NOT allUnchanged when at least one file is fresh (mixed read)", async () => {
    fs.writeFileSync(path.join(ws, "a.ts"), "const a = 1;");
    fs.writeFileSync(path.join(ws, "b.ts"), "const b = 2;");
    await handleReadFiles(["a.ts"], ctx); // a is now provided
    const mixed = await handleReadFiles(["a.ts", "b.ts"], ctx); // a unchanged, b fresh
    expect(mixed.allUnchanged).toBe(false);
    expect(mixed.text).toContain("const b = 2;");
  });

  it("reflects pending virtual edits instead of stale disk", async () => {
    fs.writeFileSync(path.join(ws, "a.ts"), "old");
    ctx.virtualFiles.set("a.ts", "new pending content");
    const out = await handleReadFiles(["a.ts"], ctx);
    expect(out.text).toContain("new pending content");
    expect(out.text).not.toContain("old");
  });
});
