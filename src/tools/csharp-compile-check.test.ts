import { describe, it, expect, vi } from "vitest";
import {
  parseCscDiagnostics,
  formatCSharpCompileResult,
  shouldCopyToSandbox,
  formatVirtualBatchResult,
  runCSharpCompileCheck,
  applyVirtualBatch,
  type CSharpCompileCheckResult,
  type VirtualBatchResult
} from "./csharp-compile-check.js";
import * as path from "node:path";
import * as fs from "node:fs";

vi.mock("node:os", () => ({
  default: {
    tmpdir: vi.fn().mockReturnValue("/mock/tmp")
  },
  tmpdir: vi.fn().mockReturnValue("/mock/tmp")
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(true), // Pretend .csproj always exists
    readdirSync: vi.fn().mockReturnValue(["Program.cs", "Test.csproj"]),
    promises: {
      mkdtemp: vi.fn().mockResolvedValue("/mock/tmp/rei-sandbox-123"),
      cp: vi.fn().mockResolvedValue(undefined),
      symlink: vi.fn().mockResolvedValue(undefined),
      readFile: vi.fn().mockImplementation(async (filePath: string) => {
        if (filePath.includes("missing")) throw new Error("File not found");
        return "using System;";
      }),
      writeFile: vi.fn().mockResolvedValue(undefined),
      rm: vi.fn().mockResolvedValue(undefined)
    }
  };
});

// Mock child_process and fs for the runCSharpCompileCheck tests
// Mock PARCIAL: la factory sin importOriginal reemplazaba el modulo entero y dejaba `spawn`
// undefined para cualquier otro test del mismo worker (rompia code-search.test.ts).
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  exec: vi.fn((cmd, options, callback) => {
    // If it's a successful mock, we simulate it
    if (cmd.includes("fail")) {
      const err = new Error("Command failed");
      (err as any).code = 1;
      (err as any).stdout = "Program.cs(1,1): error CS123: Fake error";
      (err as any).stderr = "";
      callback(err, (err as any).stdout, (err as any).stderr);
    } else {
      callback(null, "Done", "");
    }
  })
}));

describe("csharp-compile-check", () => {
  describe("parseCscDiagnostics", () => {
    it("should correctly parse standard CSC error output", () => {
      const mockWorkspace = "/mock/workspace";
      const rawOutput = `
Program.cs(10,5): error CS0029: Cannot implicitly convert type 'string' to 'int'.
Utils/Math.cs(42,1): error CS1002: ; expected.
      `;

      const diagnostics = parseCscDiagnostics(mockWorkspace, rawOutput);

      expect(diagnostics).toHaveLength(2);

      expect(diagnostics[0].filePath).toBe("Program.cs");
      expect(diagnostics[0].line).toBe(10);
      expect(diagnostics[0].column).toBe(5);
      expect(diagnostics[0].code).toBe("CS0029");
      expect(diagnostics[0].message).toBe("Cannot implicitly convert type 'string' to 'int'.");

      expect(diagnostics[1].filePath).toBe("Utils/Math.cs");
      expect(diagnostics[1].line).toBe(42);
      expect(diagnostics[1].code).toBe("CS1002");
    });

    it("should handle absolute paths and convert them to relative paths", () => {
      const mockWorkspace = process.platform === "win32" ? "C:\\mock\\workspace" : "/mock/workspace";
      const absPath = path.join(mockWorkspace, "Program.cs");
      const rawOutput = `${absPath}(10,5): error CS0029: Type error.`;

      const diagnostics = parseCscDiagnostics(mockWorkspace, rawOutput);

      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0].filePath).toBe("Program.cs");
    });

    it("should ignore unrelated text or warnings in the output", () => {
      const mockWorkspace = "/mock/workspace";
      const rawOutput = `
Microsoft (R) Build Engine version 17.0.0 for .NET
Copyright (C) Microsoft Corporation. All rights reserved.

  Program.cs(10,5): error CS0029: Type error.
Build succeeded.
      `;

      const diagnostics = parseCscDiagnostics(mockWorkspace, rawOutput);

      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0].filePath).toBe("Program.cs");
    });

    it("should deduplicate identical diagnostics", () => {
      const mockWorkspace = "/mock/workspace";
      const rawOutput = `
Program.cs(10,5): error CS0029: Type error.
Program.cs(10,5): error CS0029: Type error.
      `;

      const diagnostics = parseCscDiagnostics(mockWorkspace, rawOutput);

      expect(diagnostics).toHaveLength(1);
    });
  });

  describe("formatCSharpCompileResult", () => {
    it("should format successful results", () => {
      const result: CSharpCompileCheckResult = {
        success: true,
        diagnostics: [],
        fileCount: 5
      };

      const formatted = formatCSharpCompileResult(result);

      expect(formatted).toEqual([
        "[csc] ✓ No compilation errors found (5 files checked)."
      ]);
    });

    it("should format error results", () => {
      const result: CSharpCompileCheckResult = {
        success: false,
        diagnostics: [
          {
            filePath: "Program.cs",
            line: 10,
            column: 5,
            code: "CS0029",
            message: "Cannot convert string to int"
          }
        ],
        fileCount: 3
      };

      const formatted = formatCSharpCompileResult(result);

      expect(formatted[0]).toBe("[csc] ✗ 1 error(s) found — fix before committing:");
      expect(formatted[1]).toBe("  Program.cs:10:5  CS0029: Cannot convert string to int");
    });

    it("should cap output at 30 errors", () => {
      const diagnostics = Array.from({ length: 30 }, (_, i) => ({
        filePath: `File${i}.cs`,
        line: i + 1,
        column: 1,
        code: `CS${1000 + i}`,
        message: `Error ${i}`
      }));

      const result: CSharpCompileCheckResult = {
        success: false,
        diagnostics,
        fileCount: 30
      };

      const formatted = formatCSharpCompileResult(result);

      expect(formatted).toContain("  ... (output capped at 30 errors)");
      expect(formatted.length).toBe(32); // header + 30 errors + cap message
    });
  });

  describe("runCSharpCompileCheck", () => {
    it("should return success when no .csproj or .sln files exist", async () => {
      // Mock fs to return no C# project files
      vi.mocked(fs.readdirSync).mockReturnValueOnce(
        ["package.json"] as unknown as ReturnType<typeof fs.readdirSync>,
      );

      const result = await runCSharpCompileCheck("/mock/workspace");

      expect(result.success).toBe(true);
      expect(result.diagnostics).toEqual([]);
    });

    it("should run dotnet build and parse errors", async () => {
      const result = await runCSharpCompileCheck("/mock/workspace");

      expect(result.success).toBe(true); // Mock returns success
      expect(result.diagnostics).toEqual([]);
    });
  });

  describe("applyVirtualBatch", () => {
    it("should handle non-C# projects", async () => {
      vi.mocked(fs.readdirSync).mockReturnValueOnce(
        ["package.json"] as unknown as ReturnType<typeof fs.readdirSync>,
      );

      const result = await applyVirtualBatch("/mock/workspace", []);

      expect(result.success).toBe(true);
      expect(result.diagnostics).toEqual([]);
      expect(result.applyErrors).toEqual([]);
    });
  });

  describe("formatVirtualBatchResult", () => {
    it("should format successful batch results", () => {
      const result: VirtualBatchResult = {
        success: true,
        verifyRan: true,
        diagnostics: [],
        applyErrors: [],
        fileCount: 3,
        virtualFiles: new Map(),
        verifyCommand: "dotnet build",
        verifyStdout: "",
        verifyStderr: ""
      };

      const formatted = formatVirtualBatchResult(result);

      expect(formatted).toContain("✅ All patches applied and validated successfully");
      expect(formatted).toContain("`dotnet build`");
    });

    it("should format failed batch results", () => {
      const result: VirtualBatchResult = {
        success: false,
        verifyRan: true,
        diagnostics: [
          {
            filePath: "Program.cs",
            line: 10,
            column: 5,
            code: "CS0029",
            message: "Type error"
          }
        ],
        applyErrors: [],
        fileCount: 2,
        virtualFiles: new Map(),
        verifyCommand: "dotnet build",
        verifyStdout: "",
        verifyStderr: "Build FAILED."
      };

      const formatted = formatVirtualBatchResult(result);

      expect(formatted).toContain("❌ Validation failed with 1 compilation error(s).");
      expect(formatted).toContain("[Program.cs:10:5] CS0029: Type error");
      expect(formatted).toContain("Build FAILED.");
    });

    it("should format patch application errors", () => {
      const result: VirtualBatchResult = {
        success: false,
        verifyRan: false, // the patches never applied, so nothing was checked
        diagnostics: [],
        applyErrors: ["Failed to apply patch to Program.cs"],
        fileCount: 1,
        virtualFiles: new Map(),
        verifyCommand: "dotnet build",
        verifyStdout: "",
        verifyStderr: ""
      };

      const formatted = formatVirtualBatchResult(result);

      expect(formatted).toContain("❌ Failed to apply patches:");
      expect(formatted).toContain("- Failed to apply patch to Program.cs");
    });
  });
});