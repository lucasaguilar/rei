import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyVirtualBatch, formatVirtualBatchResult } from "./compile-check-factory.js";
import { resolveVerifyCommand } from "./compile-check-core.js";

/**
 * REI's whole claim is that it does not take the model's word: it runs the project's own verify
 * command before the turn may finish. That was true for TypeScript and C# only.
 *
 * `TypeScriptCompileAdapter.canValidate()` asked `fs.existsSync("tsconfig.json")`, and
 * `applyVirtualBatch` returns `{success: true, diagnostics: []}` when it says no — so a Rust project
 * whose code does not compile got a green final verify with an empty output, and the command REI
 * had just printed as "the check" never ran. Measured before the fix:
 *   `success: true | verifyCommand: "cargo check" | stdout: ""`
 *
 * The gate belongs on the question that matters: is there a real verify command for this project?
 *
 * Python and node drive the tests because their toolchains are always present here; the languages
 * that need an installed compiler are covered by `resolveVerifyCommand` alone.
 */
let ws: string;
beforeEach(() => { ws = mkdtempSync(join(tmpdir(), "rei-verify-")); });
afterEach(() => {
  rmSync(ws, { recursive: true, force: true });
  delete process.env.REI_SANDBOX_VERIFY_COMMAND;
});

const write = (rel: string, body: string) => {
  mkdirSync(join(ws, rel, ".."), { recursive: true });
  writeFileSync(join(ws, rel), body);
};

describe("the final verify runs whatever the language", () => {
  it("FAILS a Python project whose code does not parse", async () => {
    write("requirements.txt", "flask\n");
    write("app.py", "def broken(:\n");
    const r = await applyVirtualBatch(ws, []);
    expect(r.verifyRan).toBe(true);
    expect(r.success).toBe(false);
  }, 60_000);

  it("PASSES a Python project that does parse", async () => {
    write("requirements.txt", "flask\n");
    write("app.py", "def fine():\n    return 1\n");
    const r = await applyVirtualBatch(ws, []);
    expect(r.verifyRan).toBe(true);
    expect(r.success).toBe(true);
  }, 60_000);

  it("hands the model the tool's own output when there are no parsed diagnostics", async () => {
    // A non-TypeScript failure produces no TSxxxx diagnostics, so without the raw output the model
    // would be told "validation failed" and nothing it could act on.
    write("requirements.txt", "flask\n");
    write("app.py", "def broken(:\n");
    const r = await applyVirtualBatch(ws, []);
    const feedback = formatVirtualBatchResult(ws, r);
    expect(feedback).toMatch(/SyntaxError|invalid syntax/);
  }, 60_000);

  it("reports a project with NO verify command as not verified, not as a pass", async () => {
    write("README.md", "# docs only\n");
    expect(resolveVerifyCommand(ws)).toBe("echo ok");
    const r = await applyVirtualBatch(ws, []);
    expect(r.success).toBe(true);   // absence of a check is not a failure
    expect(r.verifyRan).toBe(false); // …but it must be distinguishable from a green
  });

  it("honours REI_SANDBOX_VERIFY_COMMAND for a language REI does not know", async () => {
    write("main.zig", "pub fn main() void {}\n");
    process.env.REI_SANDBOX_VERIFY_COMMAND = "false";
    const r = await applyVirtualBatch(ws, []);
    expect(r.verifyRan).toBe(true);
    expect(r.success).toBe(false);
  }, 60_000);

  it("still names the right command for a toolchain that is not installed here", () => {
    write("Cargo.toml", '[package]\nname = "x"\n');
    expect(resolveVerifyCommand(ws)).toBe("cargo check");
  });
});

/**
 * A missing toolchain is not a broken codebase. `cargo check` on a machine without Rust exits 127
 * with "command not found", and reporting that as "your combined changes do NOT compile" is the same
 * class of lie as the green it replaced — just in the other direction. It did not run.
 */
describe("a toolchain that is not installed", () => {
  it("is reported as NOT RUN, not as a failure", async () => {
    write("requirements.txt", "flask\n");
    process.env.REI_SANDBOX_VERIFY_COMMAND = "rei-no-such-tool-xyz --check";
    const r = await applyVirtualBatch(ws, []);
    expect(r.verifyRan).toBe(false);
    expect(r.success).toBe(true); // absence of a check, not a failing check
  }, 60_000);

  it("says which command was missing, so it is fixable", async () => {
    write("requirements.txt", "flask\n");
    process.env.REI_SANDBOX_VERIFY_COMMAND = "rei-no-such-tool-xyz --check";
    const r = await applyVirtualBatch(ws, []);
    expect(formatVirtualBatchResult(ws, r)).toMatch(/rei-no-such-tool-xyz/);
  }, 60_000);
});
