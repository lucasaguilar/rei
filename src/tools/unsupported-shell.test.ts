import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { executeCommand } from "./command-executor.js";

/**
 * Commands run with `shell: false`, so a few shell features cannot work. They used to fail in two
 * different ways, and the quieter one was worse:
 *
 *   - `for`/`if` hit "Command 'for' is not in the allow-list" — which reads as "add it to the list"
 *     and sends the model down a dead end. It cost real turns in a live session.
 *   - `$(…)` passed through LITERALLY with exit 0: no error, wrong result. `curl -H "Bearer
 *     $(cat token)"` sent the text as the token, and the 401 that followed pointed nowhere near it.
 *
 * Both must now explain themselves and name an alternative that actually exists.
 */
let ws: string;
beforeAll(() => {
  ws = mkdtempSync(join(tmpdir(), "rei-shell-"));
  process.env.REI_SHELL_TOK = "s3cret";
});
afterAll(() => {
  rmSync(ws, { recursive: true, force: true });
  delete process.env.REI_SHELL_TOK;
});
const run = (cmd: string) => executeCommand(cmd, ws);

describe("shell control flow", () => {
  for (const kw of ["for", "while", "until", "if", "case"]) {
    it(`explains '${kw}' instead of blaming the allow-list`, async () => {
      const r = await run(`${kw} x in a b; do echo $x; done`);
      expect(r.success).toBe(false);
      expect(r.stderr).toContain("shell control flow");
      expect(r.stderr).not.toContain("allow-list");
      expect(r.stderr).toContain("heredoc");
    });
  }

  it("does not flag a command that merely starts with those letters", async () => {
    const r = await run("find . -maxdepth 1 -name '*.nothing'");
    expect(r.stderr).not.toContain("shell control flow");
  });

  it("the alternative it suggests actually works", async () => {
    // The message points at a heredoc; a loop inside one must really run.
    const r = await run(`python3 - <<'PY'\nfor x in ["a", "b"]:\n    print(x)\nPY`);
    expect(r.stdout.trim().split("\n")).toEqual(["a", "b"]);
  });
});

describe("command substitution", () => {
  it("refuses $(…) instead of sending it as literal text", async () => {
    const r = await run("echo $(date)");
    expect(r.success).toBe(false);
    expect(r.stderr).toContain("command substitution");
    expect(r.stdout).not.toContain("$(date)");
  });

  it("refuses backticks too", async () => {
    const r = await run("echo `date`");
    expect(r.success).toBe(false);
    expect(r.stderr).toContain("command substitution");
  });

  it("catches it inside double quotes — the token case that returns a silent 401", async () => {
    const r = await run(`curl -H "Authorization: Bearer $(cat token.txt)" http://127.0.0.1:1/x`);
    expect(r.success).toBe(false);
    expect(r.stderr).toContain("command substitution");
  });

  it("leaves it alone inside single quotes, where it is data", async () => {
    const r = await run(`echo 'cost is $(price)'`);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe("cost is $(price)");
  });

  it("does not confuse a bare $ or a variable with substitution", async () => {
    const r = await run(`echo "tok=$REI_SHELL_TOK and 100$"`);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe("tok=s3cret and 100$");
  });

  it("leaves ordinary commands untouched", async () => {
    expect((await run("echo hola | wc -c")).exitCode).toBe(0);
    expect((await run("echo a && echo b")).stdout).toContain("b");
  });
});
