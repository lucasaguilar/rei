import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runShellCommand } from "./run-shell-command.js";

async function run(command: string, cwd: string, signal?: AbortSignal) {
  let output = "";
  const result = await runShellCommand(command, {
    cwd,
    shell: "/bin/sh",
    onOutput: (chunk) => (output += chunk),
    signal,
  });
  return { ...result, output };
}

describe("runShellCommand", () => {
  let ws: string;
  beforeEach(() => {
    ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rei-shell-")));
  });
  afterEach(() => fs.rmSync(ws, { recursive: true, force: true }));

  it("streams the output and reports the exit code", async () => {
    const ok = await run("echo hola", ws);
    expect(ok.output).toBe("hola\n");
    expect(ok.exitCode).toBe(0);
    expect((await run("exit 3", ws)).exitCode).toBe(3);
  });

  it("is a real shell: pipes, &&, and stderr all work", async () => {
    const r = await run("echo a | tr a b && echo err 1>&2", ws);
    expect(r.output).toContain("b\n");
    expect(r.output).toContain("err\n");
  });

  it("runs in the workspace", async () => {
    expect((await run("pwd", ws)).output.trim()).toBe(ws);
  });

  it("closes stdin, so a command waiting for input ends instead of hanging REI", async () => {
    // `cat` with no file reads stdin: with a live stdin it would block forever.
    const r = await run("cat", ws);
    expect(r.exitCode).toBe(0);
  });

  it("turns pagers off and makes git's editor fail fast instead of waiting on a TTY", async () => {
    const r = await run('echo "$PAGER|$GIT_PAGER|$GIT_EDITOR"', ws);
    expect(r.output.trim()).toBe("cat|cat|false");
  });

  it("an abort kills the whole pipeline, not just the shell", async () => {
    const controller = new AbortController();
    const started = Date.now();
    setTimeout(() => controller.abort(), 150);
    const r = await run("sleep 30 | cat", ws, controller.signal);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(r.aborted).toBe(true);
  });
});
