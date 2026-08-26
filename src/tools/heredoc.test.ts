import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { executeCommand } from "./command-executor.js";

/**
 * Commands run with `shell: false`, so nothing interprets `<<'EOF'` unless REI does. Before this,
 * a heredoc failed in two ways at once — and BOTH were silent or misleading:
 *
 *   1. The body was tokenized as ARGUMENTS and the child got an empty stdin, so
 *      `python3 - <<'EOF' … EOF` exited 0 having executed nothing. The model reads that as success.
 *   2. `;`, `&&` and `/` inside the body were treated as command separators, so a Python line like
 *      `end = i; break` produced `Security Error: Command 'break' is not in the allow-list.`
 *
 * The second one is taken verbatim from a real session log.
 */
let ws: string;
beforeAll(() => { ws = mkdtempSync(join(tmpdir(), "rei-hd-")); process.env.REI_HD_TOKEN = "s3cret"; });
afterAll(() => { rmSync(ws, { recursive: true, force: true }); delete process.env.REI_HD_TOKEN; });

const run = (cmd: string) => executeCommand(cmd, ws);

describe("heredoc", () => {
  it("runs the script instead of silently doing nothing", async () => {
    const r = await run(`python3 - <<'EOF'\nprint("hello from stdin")\nEOF`);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe("hello from stdin");
  });

  it("a ';' inside the body is code, not a command separator (the reported bug)", async () => {
    const r = await run(
      `python3 - <<'EOF'\nfor i in range(3):\n    if i == 1:\n        end = i; break\nprint("ok", end)\nEOF`,
    );
    expect(r.stderr).not.toMatch(/allow-list/);
    expect(r.stdout.trim()).toBe("ok 1");
  });

  it("slashes in paths inside the body don't split the command", async () => {
    const r = await run(`python3 - <<'EOF'\np = ".rei/tool-output/x.md"\nprint(p.split("/")[-1])\nEOF`);
    expect(r.stdout.trim()).toBe("x.md");
  });

  it("a quoted delimiter keeps $VAR literal", async () => {
    const r = await run(`python3 - <<'EOF'\nprint("tok=$REI_HD_TOKEN")\nEOF`);
    expect(r.stdout.trim()).toBe("tok=$REI_HD_TOKEN");
  });

  it("an unquoted delimiter expands $VAR", async () => {
    const r = await run(`python3 - <<EOF\nprint("tok=$REI_HD_TOKEN")\nEOF`);
    expect(r.stdout.trim()).toBe("tok=s3cret");
  });

  it("keeps a redirect that trails the delimiter", async () => {
    const r = await run(`python3 - <<'EOF' > out.txt\nprint("redirected")\nEOF`);
    expect(r.exitCode).toBe(0);
    expect(readFileSync(join(ws, "out.txt"), "utf8").trim()).toBe("redirected");
  });

  it("preserves blank lines and indentation in the body", async () => {
    const r = await run(`python3 - <<'EOF'\ndef f():\n\n    return 42\n\nprint(f())\nEOF`);
    expect(r.stdout.trim()).toBe("42");
  });

  it("still enforces the allow-list on the command itself", async () => {
    const r = await run(`notacommand - <<'EOF'\nprint("x")\nEOF`);
    expect(r.success).toBe(false);
    expect(r.stderr).toMatch(/allow-list/);
  });

  it("works inside a && chain — the heredoc feeds the LAST command, not the cd", async () => {
    const r = await run(`cd . && python3 - <<'PY'\nprint("chained")\nPY`);
    expect(r.stderr).not.toMatch(/allow-list/);
    expect(r.stdout.trim()).toBe("chained");
  });

  it("runs commands that FOLLOW the terminator instead of dropping them", async () => {
    const r = await run(`python3 - <<'PY'\nprint("first")\nPY\necho second`);
    expect(r.stdout).toContain("first");
    expect(r.stdout).toContain("second");
  });

  it("the full shape from the reported log: cd && redirect + follow-up", async () => {
    const r = await run(
      `cd . && python3 - > s.txt <<'PY'\nstrong=False; code=False\nprint("D", strong, code)\nPY\nwc -l s.txt`,
    );
    expect(r.stderr).not.toMatch(/allow-list/);
    expect(r.stdout.trim()).toMatch(/^1\b/); // wc counted the redirected line
    expect(readFileSync(join(ws, "s.txt"), "utf8").trim()).toBe("D False False");
  });

  it("leaves ordinary commands untouched", async () => {
    const r = await run(`echo hola`);
    expect(r.stdout.trim()).toBe("hola");
  });

  it("an unterminated heredoc is not treated as one", async () => {
    const r = await run(`echo cerrado`);
    expect(r.stdout.trim()).toBe("cerrado");
  });
});
