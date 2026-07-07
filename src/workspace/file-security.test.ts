import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { resolveWorkspacePath } from "./file-security.js";

describe("resolveWorkspacePath — doubled-workspace-name guard", () => {
  let ws: string;
  let base: string;
  beforeEach(() => {
    ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rei-ws-")));
    base = path.basename(ws);
  });
  afterEach(() => fs.rmSync(ws, { recursive: true, force: true }));

  it("resolves a normal relative path unchanged", () => {
    expect(resolveWorkspacePath(".rei/tmp/reconcile.py", ws)).toBe(
      path.join(ws, ".rei/tmp/reconcile.py"),
    );
  });

  it("collapses a phantom doubled workspace-name prefix", () => {
    // Model wrote "<base>/x.py" while already inside <base> → would be <ws>/<base>/x.py (phantom).
    const resolved = resolveWorkspacePath(`${base}/.rei/tmp/reconcile.py`, ws);
    expect(resolved).toBe(path.join(ws, ".rei/tmp/reconcile.py"));
  });

  it("keeps an INTENTIONAL nested same-named dir (e.g. Django myproject/myproject)", () => {
    fs.mkdirSync(path.join(ws, base)); // the nested dir really exists → not a phantom
    const resolved = resolveWorkspacePath(`${base}/settings.py`, ws);
    expect(resolved).toBe(path.join(ws, base, "settings.py"));
  });

  it("leaves an absolute in-workspace path alone", () => {
    const abs = path.join(ws, "src/index.ts");
    expect(resolveWorkspacePath(abs, ws)).toBe(abs);
  });

  it("does not touch paths that merely start with the base name as a prefix of a longer segment", () => {
    // "<base>foo/x" is NOT "<base>/..." — must not be collapsed.
    const resolved = resolveWorkspacePath(`${base}foo/x.py`, ws);
    expect(resolved).toBe(path.join(ws, `${base}foo/x.py`));
  });
});
