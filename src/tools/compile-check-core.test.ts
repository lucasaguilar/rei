import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  createSandboxWorkspace,
  removeSandboxWorkspace,
} from "./compile-check-core.js";

describe("compile-check-core sandbox regression", () => {
  let workspacePath = "";
  let sandboxPath = "";

  beforeEach(async () => {
    workspacePath = await fs.promises.mkdtemp(path.join(os.tmpdir(), "rei-check-core-test-"));
    await fs.promises.mkdir(path.join(workspacePath, "src"), { recursive: true });
    await fs.promises.writeFile(path.join(workspacePath, "src", "index.ts"), "export const ok = true;\n", "utf8");
    await fs.promises.mkdir(path.join(workspacePath, "node_modules"), { recursive: true });
  });

  afterEach(async () => {
    if (sandboxPath) {
      await removeSandboxWorkspace(sandboxPath);
      sandboxPath = "";
    }
    if (workspacePath) {
      await fs.promises.rm(workspacePath, { recursive: true, force: true });
      workspacePath = "";
    }
    vi.restoreAllMocks();
  });

  it("continues sandbox creation when node_modules symlink is blocked", async () => {
    const symlinkError = Object.assign(new Error("symlink blocked by policy"), {
      code: "EPERM",
    });
    const symlinkSpy = vi
      .spyOn(fs.promises, "symlink")
      .mockRejectedValueOnce(symlinkError as NodeJS.ErrnoException);

    sandboxPath = await createSandboxWorkspace(workspacePath);

    expect(symlinkSpy).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(sandboxPath)).toBe(true);
    expect(fs.existsSync(path.join(sandboxPath, "src", "index.ts"))).toBe(true);
    expect(fs.existsSync(path.join(sandboxPath, "node_modules"))).toBe(false);
  });
});
