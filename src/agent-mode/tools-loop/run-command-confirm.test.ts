import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

// The confirmed command itself must never run in these tests — only the read-only git queries
// the confirm makes to describe it.
vi.mock("../../tools/command-executor.js", () => ({
  executeCommand: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
  limitCommandOutput: vi.fn((s: string) => s),
}));

import { handleRunCommand, describeGitMutant } from "./builtin-handlers.js";
import type { Elicitation } from "../../chat/elicitation.js";

const fakeLogger = new Proxy({}, { get: () => vi.fn() }) as never;
const statusCtx = { logger: fakeLogger, emitStatus: () => {} };

let repo: string;

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" });
}

function write(rel: string, content: string): void {
  fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
  fs.writeFileSync(path.join(repo, rel), content);
}

/** Runs the command through the gate, declines, and returns the question the user saw. */
async function promptFor(cmd: string): Promise<string> {
  let seen: Elicitation | undefined;
  const elicit = async (e: Elicitation) => {
    seen = e;
    return { id: e.id, value: "no" };
  };
  await handleRunCommand(cmd, { ...statusCtx, workspacePath: repo, elicit });
  if (!seen) throw new Error(`no confirm was asked for: ${cmd}`);
  return seen.message;
}

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "rei-confirm-"));
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  write("tracked.ts", "a\nb\n");
  write("gone.ts", "x\n");
  git("add", "-A");
  git("commit", "-qm", "init");
});

afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

describe("run_command confirm — what the command will touch", () => {
  it("names EVERY git action in a chain, not only the first (the push was invisible)", () => {
    const d = describeGitMutant("git add -A && git commit -m 'x' && git push");
    expect(d).toContain("commit");
    expect(d).toContain("push");
  });

  it("lists the files `git add -A && git commit` will commit, untracked included", async () => {
    write("tracked.ts", "a\nB\nc\n");
    fs.rmSync(path.join(repo, "gone.ts"));
    write("src/new.ts", "n\n");
    const msg = await promptFor("git add -A && git commit -m 'feat: x'");
    expect(msg).toMatch(/M\s+tracked\.ts/);
    expect(msg).toMatch(/D\s+gone\.ts/);
    expect(msg).toMatch(/\?\?\s+src\/new\.ts/);
    expect(msg).toContain("Files (3)");
  });

  it("lists only what is staged for a bare `git commit`", async () => {
    write("tracked.ts", "changed\n");
    write("other.ts", "not staged\n");
    git("add", "tracked.ts");
    const msg = await promptFor("git commit -m 'x'");
    expect(msg).toContain("tracked.ts");
    expect(msg).not.toContain("other.ts");
  });

  it("flags a secret-looking file about to be committed", async () => {
    write(".env", "KEY=1\n");
    const msg = await promptFor("git add . && git commit -m 'x'");
    expect(msg).toContain(".env");
    expect(msg).toMatch(/secret/i);
  });

  it("caps a long file list instead of flooding the transcript", async () => {
    for (let i = 0; i < 30; i++) write(`many/f${i}.ts`, `${i}\n`);
    const msg = await promptFor("git add -A && git commit -m 'x'");
    expect(msg).toContain("Files (30)");
    expect(msg).toMatch(/and 15 more/);
  });

  it("says where a push goes, and that there is no upstream when there is none", async () => {
    const msg = await promptFor("git push");
    expect(msg).toMatch(/Push: main/);
    expect(msg).toMatch(/no upstream/i);
  });

  it("shows the files an rm glob expands to", async () => {
    write("a.tmp", "");
    write("b.tmp", "");
    const msg = await promptFor("rm *.tmp");
    expect(msg).toContain("a.tmp");
    expect(msg).toContain("b.tmp");
  });

  it("falls back to the plain question outside a git repo", async () => {
    fs.rmSync(path.join(repo, ".git"), { recursive: true, force: true });
    const msg = await promptFor("git commit -m 'x'");
    expect(msg).toContain("git commit -m 'x'");
    expect(msg).toContain("Run it?");
  });
});
