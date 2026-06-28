import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createVirtualFileTree } from "./virtual-file-tree.js";

describe("createVirtualFileTree", () => {
  let ws: string;
  beforeEach(() => {
    ws = fs.mkdtempSync(path.join(os.tmpdir(), "rei-vft-test-"));
  });
  afterEach(() => fs.rmSync(ws, { recursive: true, force: true }));

  it("reads disk (cached) and returns '' for a missing file", async () => {
    fs.writeFileSync(path.join(ws, "a.ts"), "const a = 1;");
    const t = createVirtualFileTree(ws);
    expect(await t.readDisk("a.ts")).toBe("const a = 1;");
    expect(await t.readDisk("missing.ts")).toBe("");
    expect(t.diskCache.get("a.ts")).toBe("const a = 1;");
  });

  it("currentContent prefers the pending virtual content over disk", async () => {
    fs.writeFileSync(path.join(ws, "a.ts"), "disk");
    const t = createVirtualFileTree(ws);
    expect(await t.currentContent("a.ts")).toBe("disk");
    t.virtualFiles.set("a.ts", "edited");
    expect(await t.currentContent("a.ts")).toBe("edited");
  });

  it("virtualEdits expresses the tree as disk→pending rewrites", async () => {
    fs.writeFileSync(path.join(ws, "a.ts"), "old");
    const t = createVirtualFileTree(ws);
    t.virtualFiles.set("a.ts", "new");
    expect(await t.virtualEdits()).toEqual([{ file: "a.ts", search: "old", replace: "new" }]);
  });

  it("persistToDisk writes pending content to disk (creating dirs)", async () => {
    const t = createVirtualFileTree(ws);
    t.virtualFiles.set("sub/b.ts", "hello");
    await t.persistToDisk(["sub/b.ts"]);
    expect(fs.readFileSync(path.join(ws, "sub", "b.ts"), "utf8")).toBe("hello");
  });

  it("resolveTarget rejects missing args and paths escaping the workspace", () => {
    const t = createVirtualFileTree(ws);
    expect(() => t.resolveTarget(undefined)).toThrow(/Missing required/);
    expect(() => t.resolveTarget("../escape.ts")).toThrow(/outside the working directory/);
    expect(t.resolveTarget("ok.ts")).toBe("ok.ts");
  });
});
