import { describe, expect, it, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveWorkspacePath } from "./run-cli.js";

/**
 * The workspace the agent WRITES to must be the workspace whose `.env` was READ. They were resolved
 * by two different rules once — `load-env.ts` honoured `REI_WORKSPACE_PATH`, the CLI did not — and a
 * one-shot run pointed at a temp directory created its files in the launch directory instead.
 */
describe("resolveWorkspacePath", () => {
  const previous = process.env.REI_WORKSPACE_PATH;
  const made: string[] = [];

  const tempDir = (): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rei-ws-"));
    made.push(dir);
    return dir;
  };

  afterEach(() => {
    if (previous === undefined) delete process.env.REI_WORKSPACE_PATH;
    else process.env.REI_WORKSPACE_PATH = previous;
    for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("uses REI_WORKSPACE_PATH when no --workspace was passed", () => {
    const dir = tempDir();
    process.env.REI_WORKSPACE_PATH = dir;
    expect(resolveWorkspacePath(undefined)).toBe(path.resolve(dir));
  });

  it("lets --workspace outrank the env var", () => {
    const flag = tempDir();
    process.env.REI_WORKSPACE_PATH = tempDir();
    expect(resolveWorkspacePath(flag)).toBe(path.resolve(flag));
  });

  it("falls back to the cwd when neither is set", () => {
    delete process.env.REI_WORKSPACE_PATH;
    expect(resolveWorkspacePath(undefined)).toBe(process.cwd());
  });
});
