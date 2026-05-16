import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

vi.mock("../context/ast-providers/ast-provider-factory.js", () => ({
  AstProviderFactory: {
    resolve: vi.fn(() => ({
      supports: () => true,
      extractDependencies: vi.fn(async () => []),
      extractSkeleton: vi.fn(async () => []),
      extractChunks: vi.fn(async () => {
        throw new Error("simulated parser failure");
      }),
    })),
  },
}));

const { generateRepoMapForFile } = await import("./repo-map-generator.js");

describe("repo-map-generator fallback behavior", () => {
  let tmpWorkspace: string;

  beforeEach(async () => {
    tmpWorkspace = await fs.mkdtemp(
      path.join(os.tmpdir(), "rei-fallback-test-"),
    );
  });

  afterEach(async () => {
    await fs.rm(tmpWorkspace, { recursive: true, force: true });
  });

  it("falls back to HeuristicAstProvider when the primary AST provider throws", async () => {
    const filePath = path.join(tmpWorkspace, "fallback.py");

    await fs.writeFile(
      filePath,
      [
        "def fallback_func():",
        "    return True",
        "",
        "class FallbackClass:",
        "    pass",
        "",
      ].join("\n"),
      "utf8",
    );

    const output = await generateRepoMapForFile(tmpWorkspace, filePath);

    expect(output).not.toBeNull();
    expect(output).toContain("// FILE: fallback.py");
    expect(output).toContain("def fallback_func;");
    expect(output).toContain("class FallbackClass {");
  });
});
