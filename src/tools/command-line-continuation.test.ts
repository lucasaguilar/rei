import { describe, it, expect } from "vitest";
import { executeCommand } from "./command-executor.js";

/**
 * Commands run with `shell: false`, so nothing interprets a shell's line continuation for us.
 *
 * A model writing a long chain formats it the way it would in a terminal — `git add … && \` then a
 * newline — and the backslash and newline stayed glued to the next word. The command NAME became
 * "\<newline>git", and the allow-list rejected a command nobody had typed:
 *
 *     Security Error: Command '\
 *     git' is not in the allow-list.
 *
 * Which reads as REI refusing `git`, not as a parsing bug.
 */
const ws = process.cwd();

describe("line continuations", () => {
  it("runs a chain written across lines with trailing backslashes", async () => {
    const r = await executeCommand("echo uno && \\\n  echo dos", ws);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("uno");
    expect(r.stdout).toContain("dos");
  });

  it("does not carry the backslash into the command name", async () => {
    const r = await executeCommand("echo a && \\\necho b", ws);
    expect(r.stderr).not.toContain("allow-list");
  });

  it("handles several continuations in one chain", async () => {
    const r = await executeCommand("echo a && \\\necho b && \\\necho c", ws);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.replace(/\s+/g, " ")).toContain("a b c");
  });

  it("accepts CRLF line endings", async () => {
    const r = await executeCommand("echo a && \\\r\necho b", ws);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("b");
  });

  it("keeps a continuation literal inside single quotes, as a shell does", async () => {
    const r = await executeCommand("echo 'a\\\nb'", ws);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("\\");
  });
});

describe("unquoted whitespace separates arguments", () => {
  it("treats a newline as a separator, not as part of a word", async () => {
    const r = await executeCommand("echo uno\ndos", ws);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("uno");
  });

  it("still keeps quoted whitespace inside one argument", async () => {
    // The separator change must not split a quoted string — `git commit -m "a b"` is one argument.
    const r = await executeCommand('echo "uno   dos"', ws);
    expect(r.stdout).toContain("uno   dos");
  });

  it("keeps a quoted newline inside the argument", async () => {
    const r = await executeCommand('echo "uno\ndos"', ws);
    expect(r.stdout).toContain("uno\ndos");
  });
});

describe("command substitution", () => {
  it("names the multi-line commit pattern that does work", async () => {
    // The shape models reach for is `git commit -m "$(cat <<'EOF' … EOF)"` — a heredoc wrapped in a
    // substitution. The heredoc alone already does the job, so the refusal says so; without that
    // the model retries the same shape.
    const r = await executeCommand('git commit -m "$(cat msg.txt)"', ws);
    expect(r.exitCode).toBe(-1);
    expect(r.stderr).toContain("git commit -F -");
  });

  it("runs a heredoc fed straight to a command's stdin", async () => {
    const r = await executeCommand("cat - <<'EOF'\nline one\n\nline two\nEOF", ws);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("line one");
    expect(r.stdout).toContain("line two"); // blank lines inside the body survive
  });
});
