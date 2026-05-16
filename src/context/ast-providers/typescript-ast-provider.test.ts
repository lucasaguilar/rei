import { describe, expect, it } from "vitest";
import { TypeScriptAstProvider } from "./typescript-ast-provider.js";
import type { SourceFileLike } from "./ast-provider.js";

describe("TypeScriptAstProvider", () => {
  it("parses files when filePath is root-relative posix", async () => {
    const provider = new TypeScriptAstProvider();
    const file: SourceFileLike = {
      filePath: "/src/index.ts",
      languageId: "typescript",
      content: "export const value = 1;",
    };

    const chunks = await provider.extractChunks(file);
    expect(chunks.some((chunk) => chunk.symbolName === "value")).toBe(true);
  });

  it("parses files when filePath is absolute windows", async () => {
    const provider = new TypeScriptAstProvider();
    const file: SourceFileLike = {
      filePath: "C:/dev/typescriptApp/src/index.ts",
      languageId: "typescript",
      content: "export function hello(): string { return 'ok'; }",
    };

    const chunks = await provider.extractChunks(file);
    expect(chunks.some((chunk) => chunk.symbolName === "hello")).toBe(true);
  });
});
