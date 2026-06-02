import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { executeCommand } from "./command-executor.js";

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
