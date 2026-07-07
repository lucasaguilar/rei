import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { executeCommand, limitCommandOutput } from "./command-executor.js";

describe("limitCommandOutput", () => {
  const saved = process.env.REI_MAX_COMMAND_OUTPUT;
  afterEach(() => {
    if (saved === undefined) delete process.env.REI_MAX_COMMAND_OUTPUT;
    else process.env.REI_MAX_COMMAND_OUTPUT = saved;
  });

  it("passes output through untouched when under the default cap", () => {
    delete process.env.REI_MAX_COMMAND_OUTPUT;
    const out = "x".repeat(10000); // a medium source file — was truncated under the old 6000 cap
    expect(limitCommandOutput(out)).toBe(out);
  });

  it("truncates the MIDDLE (keeps head + tail) past the cap, with a marker", () => {
    delete process.env.REI_MAX_COMMAND_OUTPUT;
    const out = "A".repeat(20000) + "B".repeat(20000); // 40k > 24k default
    const limited = limitCommandOutput(out);
    expect(limited.length).toBeLessThan(out.length);
    expect(limited).toContain("Truncated");
    expect(limited.startsWith("A")).toBe(true); // head kept
    expect(limited.endsWith("B")).toBe(true); // tail kept
  });

  it("honors REI_MAX_COMMAND_OUTPUT", () => {
    process.env.REI_MAX_COMMAND_OUTPUT = "100";
    const out = "y".repeat(500);
    const limited = limitCommandOutput(out);
    expect(limited).toContain("Truncated");
    expect(limited.length).toBeLessThan(out.length);
  });

  it("falls back to the default for an invalid env value", () => {
    process.env.REI_MAX_COMMAND_OUTPUT = "not-a-number";
    expect(limitCommandOutput("z".repeat(10000))).toBe("z".repeat(10000));
  });
});

describe("command-executor: rm command security checks", () => {
  let tempWorkspace = "";
  let tempHome = "";
  let originalHome: string | undefined;

  beforeEach(async () => {
    // Create temporary workspace
    tempWorkspace = await fs.promises.mkdtemp(path.join(os.tmpdir(), "rei-ws-test-"));
    // Create temporary home dir for ~/.rei mocking
    tempHome = await fs.promises.mkdtemp(path.join(os.tmpdir(), "rei-home-test-"));
    await fs.promises.mkdir(path.join(tempHome, ".rei"), { recursive: true });

    // Mock process.env.HOME
    originalHome = process.env.HOME;
    process.env.HOME = tempHome;
  });

  afterEach(async () => {
    if (originalHome !== undefined) {
      process.env.HOME = originalHome;
    } else {
      delete process.env.HOME;
    }

    if (tempWorkspace) {
      await fs.promises.rm(tempWorkspace, { recursive: true, force: true });
    }
    if (tempHome) {
      await fs.promises.rm(tempHome, { recursive: true, force: true });
    }
  });

  it("allows deleting a simple file inside the workspace", async () => {
    const filePath = path.join(tempWorkspace, "test-file.txt");
    await fs.promises.writeFile(filePath, "hello");
    expect(fs.existsSync(filePath)).toBe(true);

    const result = await executeCommand(`rm "${filePath}"`, tempWorkspace);
    expect(result.success).toBe(true);
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it("allows deleting a simple file inside ~/.rei", async () => {
    const filePath = path.join(tempHome, ".rei", "test-file.txt");
    await fs.promises.writeFile(filePath, "hello");
    expect(fs.existsSync(filePath)).toBe(true);

    const result = await executeCommand(`rm "${filePath}"`, tempWorkspace);
    expect(result.success).toBe(true);
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it("blocks deleting a file outside allowed directories", async () => {
    const outsideDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "rei-outside-test-"));
    const filePath = path.join(outsideDir, "secret.txt");
    await fs.promises.writeFile(filePath, "secret content");
    expect(fs.existsSync(filePath)).toBe(true);

    try {
      const result = await executeCommand(`rm "${filePath}"`, tempWorkspace);
      expect(result.success).toBe(false);
      expect(result.stderr).toContain("Security Error: rm target");
      expect(fs.existsSync(filePath)).toBe(true); // file still exists
    } finally {
      await fs.promises.rm(outsideDir, { recursive: true, force: true });
    }
  });

  it("blocks recursive deletion with -r flag", async () => {
    const result = await executeCommand("rm -r folder", tempWorkspace);
    expect(result.success).toBe(false);
    expect(result.stderr).toContain("Security Error: Recursive deletion is not allowed.");
  });

  it("blocks recursive deletion with -R flag", async () => {
    const result = await executeCommand("rm -f -R folder", tempWorkspace);
    expect(result.success).toBe(false);
    expect(result.stderr).toContain("Security Error: Recursive deletion is not allowed.");
  });

  it("blocks recursive deletion with --recursive flag", async () => {
    const result = await executeCommand("rm --recursive folder", tempWorkspace);
    expect(result.success).toBe(false);
    expect(result.stderr).toContain("Security Error: Recursive deletion is not allowed.");
  });
});

describe("command-executor: pipefail semantics", () => {
  let tempWorkspace = "";

  beforeEach(async () => {
    tempWorkspace = await fs.promises.mkdtemp(path.join(os.tmpdir(), "rei-pipe-test-"));
  });
  afterEach(async () => {
    if (tempWorkspace) await fs.promises.rm(tempWorkspace, { recursive: true, force: true });
  });

  it("reports failure when an upstream stage fails, even if the last stage exits 0", async () => {
    // `false` exits 1; without pipefail the pipeline would inherit `head`'s 0.
    const result = await executeCommand("false | head -5", tempWorkspace);
    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(1);
  });

  it("keeps success for a normal pipe whose last stage exits 0", async () => {
    const result = await executeCommand('printf "a\\nb\\nc\\n" | head -1', tempWorkspace);
    expect(result.success).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("a");
  });

  it("does not fail when only the last stage filters output (head truncation)", async () => {
    const result = await executeCommand('true | head -1', tempWorkspace);
    expect(result.success).toBe(true);
    expect(result.exitCode).toBe(0);
  });

  it("does not hang on a command that reads stdin (gets EOF, not a block)", async () => {
    // `cat` with no args reads stdin forever with an inherited/open stdin; with stdin closed it
    // returns immediately. If this test times out, the stdin=ignore fix regressed.
    const result = await executeCommand("cat", tempWorkspace);
    expect(result.exitCode).toBe(0);
  }, 5000);

  it("kills a command that runs forever and reports a timeout", async () => {
    process.env.REI_COMMAND_TIMEOUT_MS = "600";
    try {
      const result = await executeCommand('node -e "setInterval(()=>{},1000)"', tempWorkspace);
      expect(result.success).toBe(false);
      expect(result.stderr).toContain("timed out");
    } finally {
      delete process.env.REI_COMMAND_TIMEOUT_MS;
    }
  }, 5000);
});
