import { describe, expect, it } from "vitest";
import { TypeScriptAstProvider } from "./typescript-ast-provider.js";
import type { SourceFileLike } from "./ast-provider.js";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

describe("TypeScriptAstProvider", () => {
  it("parses files when absoluteFilePath is provided", async () => {
    const provider = new TypeScriptAstProvider();
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "rei-ts-provider-"));
    const absFilePath = path.join(workspace, "src", "index.ts");
    await fs.mkdir(path.dirname(absFilePath), { recursive: true });
    await fs.writeFile(absFilePath, "export const value = 1;", "utf8");

    const file: SourceFileLike = {
      filePath: "src/index.ts",
      absoluteFilePath: absFilePath,
      languageId: "typescript",
      content: "export const value = 1;",
    };

    const chunks = await provider.extractChunks(file);
    expect(chunks.some((chunk) => chunk.symbolName === "value")).toBe(true);

    await fs.rm(workspace, { recursive: true, force: true });
  });

  it("falls back to in-memory parsing when absoluteFilePath is unavailable", async () => {
    const provider = new TypeScriptAstProvider();
    const file: SourceFileLike = {
      filePath: "src/index.ts",
      languageId: "typescript",
      content: "export function hello(): string { return 'ok'; }",
    };

    const chunks = await provider.extractChunks(file);
    expect(chunks.some((chunk) => chunk.symbolName === "hello")).toBe(true);
  });
});
