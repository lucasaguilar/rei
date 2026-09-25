import { describe, it, expect, vi } from "vitest";
import { 
  parseTscDiagnostics, 
  formatTypeScriptCompileResult,
  shouldCopyToSandbox,
  formatVirtualBatchResult,
  runTypeScriptCompileCheck,
  applyVirtualBatch,
  type TypeScriptCompileCheckResult,
  type VirtualBatchResult
} from "./typescript-compile-check.js";
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
    existsSync: vi.fn().mockReturnValue(true), // Pretend tsconfig.json always exists
    // The verify gate now asks detectProjectType() whether a real command exists, and that reads the
    // directory. Unmocked, readdirSync throws on this fake path, the workspace looks EMPTY, and every
    // check is skipped — which silently turned the tests below into no-ops.
    readdirSync: vi.fn().mockReturnValue(["src", "tsconfig.json", "package.json"]),
    promises: {
      mkdtemp: vi.fn().mockResolvedValue("/mock/tmp/rei-sandbox-123"),
      cp: vi.fn().mockResolvedValue(undefined),
      symlink: vi.fn().mockResolvedValue(undefined),
      readFile: vi.fn().mockImplementation(async (filePath: string) => {
        if (filePath.includes("missing")) throw new Error("File not found");
        return "const a = 1;";
      }),
      writeFile: vi.fn().mockResolvedValue(undefined),
      rm: vi.fn().mockResolvedValue(undefined)
    }
  };
});
// Mock child_process and fs for the runTypeScriptCompileCheck tests
// Mock PARCIAL: la factory sin importOriginal reemplazaba el modulo entero y dejaba `spawn`
// undefined para cualquier otro test del mismo worker (rompia code-search.test.ts).
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  exec: vi.fn((cmd, options, callback) => {
    // If it's a successful mock, we simulate it
    if (cmd.includes("fail")) {
      const err = new Error("Command failed");
      (err as any).code = 1;
      (err as any).stdout = "src/index.ts(1,1): error TS123: Fake error";
      (err as any).stderr = "";
      callback(err, (err as any).stdout, (err as any).stderr);
    } else {
      callback(null, "Done", "");
    }
  })
}));

describe("typescript-compile-check", () => {
  describe("parseTscDiagnostics", () => {
    it("should correctly parse standard tsc error output", () => {
      const mockWorkspace = "/mock/workspace";
      const rawOutput = `
src/index.ts(10,5): error TS2322: Type 'string' is not assignable to type 'number'.
src/utils/math.ts(42,1): error TS1005: ',' expected.
      `;

      const diagnostics = parseTscDiagnostics(mockWorkspace, rawOutput);
      
      expect(diagnostics).toHaveLength(2);
      
      expect(diagnostics[0].filePath).toBe("src/index.ts");
      expect(diagnostics[0].line).toBe(10);
      expect(diagnostics[0].column).toBe(5);
      expect(diagnostics[0].code).toBe(2322);
      expect(diagnostics[0].message).toBe("Type 'string' is not assignable to type 'number'.");

      expect(diagnostics[1].filePath).toBe("src/utils/math.ts");
      expect(diagnostics[1].line).toBe(42);
      expect(diagnostics[1].code).toBe(1005);
    });

    it("should handle absolute paths and convert them to relative paths", () => {
      const mockWorkspace = process.platform === "win32" ? "C:\\mock\\workspace" : "/mock/workspace";
      const absPath = path.join(mockWorkspace, "src/index.ts");
      const rawOutput = `${absPath}(10,5): error TS2322: Type error.`;

      const diagnostics = parseTscDiagnostics(mockWorkspace, rawOutput);
      
      expect(diagnostics).toHaveLength(1);
      // Windows paths in tsc might come as C:/... but our parser standardizes to relative with forward slashes
      expect(diagnostics[0].filePath).toBe("src/index.ts");
    });

    it("should ignore unrelated text or warnings in the output", () => {
      const mockWorkspace = "/mock/workspace";
      const rawOutput = `
Starting compilation...
This is some random npm output
src/index.ts(10,5): error TS2322: Type error.
Done.
      `;

      const diagnostics = parseTscDiagnostics(mockWorkspace, rawOutput);
      expect(diagnostics).toHaveLength(1);
    });

    it("should filter out duplicate error messages", () => {
      const mockWorkspace = "/mock/workspace";
      const rawOutput = `
src/index.ts(10,5): error TS2322: Type error.
src/index.ts(10,5): error TS2322: Type error.
      `;

      const diagnostics = parseTscDiagnostics(mockWorkspace, rawOutput);
      expect(diagnostics).toHaveLength(1);
    });
  });

  describe("formatTypeScriptCompileResult", () => {
    it("should format a successful result", () => {
      const result: TypeScriptCompileCheckResult = {
        success: true,
        diagnostics: [],
        fileCount: 42
      };

      const formatted = formatTypeScriptCompileResult(result);
      expect(formatted).toHaveLength(1);
      expect(formatted[0]).toContain("✓ No type errors found");
      expect(formatted[0]).toContain("42 files checked");
    });

    it("should format a failed result with errors", () => {
      const result: TypeScriptCompileCheckResult = {
        success: false,
        fileCount: 0,
        diagnostics: [
          { filePath: "src/a.ts", line: 1, column: 2, code: 123, message: "Error 1" },
          { filePath: "src/b.ts", line: 3, column: 4, code: 456, message: "Error 2" }
        ]
      };

      const formatted = formatTypeScriptCompileResult(result);
      expect(formatted.length).toBeGreaterThan(1);
      expect(formatted[0]).toContain("✗ 2 error(s) found");
      expect(formatted[1]).toContain("src/a.ts:1:2");
      expect(formatted[1]).toContain("TS123: Error 1");
    });

    it("should cap the output indication if there are exactly 30 errors", () => {
      // Simulate exactly 30 errors
      const diag = { filePath: "src/a.ts", line: 1, column: 1, code: 1, message: "Err" };
      const result: TypeScriptCompileCheckResult = {
        success: false,
        fileCount: 0,
        diagnostics: Array(30).fill(diag)
      };

      const formatted = formatTypeScriptCompileResult(result);
      // Header + 30 errors + "capped" message
      expect(formatted).toHaveLength(32);
      expect(formatted[31]).toContain("output capped at 30 errors");
    });
    describe("shouldCopyToSandbox", () => {
    it("should ignore .git and node_modules directories", () => {
      expect(shouldCopyToSandbox(".git/config")).toBe(false);
      expect(shouldCopyToSandbox("node_modules/lodash/index.js")).toBe(false);
      expect(shouldCopyToSandbox(".git")).toBe(false);
      expect(shouldCopyToSandbox("node_modules")).toBe(false);
    });

    it("should allow regular source files", () => {
      expect(shouldCopyToSandbox("src/index.ts")).toBe(true);
      expect(shouldCopyToSandbox("package.json")).toBe(true);
      expect(shouldCopyToSandbox(".gitignore")).toBe(true);
      expect(shouldCopyToSandbox("README.md")).toBe(true);
    });

    it("should handle windows paths", () => {
      expect(shouldCopyToSandbox(".git\\config")).toBe(false);
      expect(shouldCopyToSandbox("src\\index.ts")).toBe(true);
    });
  });

  describe("formatVirtualBatchResult", () => {
    it("should format successful batch result", () => {
      const result: VirtualBatchResult = {
        success: true,
        diagnostics: [],
        applyErrors: [],
        fileCount: 1,
        virtualFiles: new Map(),
        verifyCommand: "npx tsc --noEmit",
        verifyStdout: "",
        verifyStderr: ""
      };
      
      const formatted = formatVirtualBatchResult(result);
      expect(formatted).toContain("All patches applied and validated successfully");
      expect(formatted).toContain("npx tsc --noEmit");
    });

    it("should format apply errors (search and replace failed)", () => {
      const result: VirtualBatchResult = {
        success: false,
        diagnostics: [],
        applyErrors: ["Could not find exact match for search block in src/index.ts"],
        fileCount: 0,
        virtualFiles: new Map(),
        verifyCommand: "npx tsc --noEmit",
        verifyStdout: "",
        verifyStderr: ""
      };
      
      const formatted = formatVirtualBatchResult(result);
      expect(formatted).toContain("Failed to apply patches");
      expect(formatted).toContain("Could not find exact match");
    });

    it("should format compilation diagnostics (tsc failed)", () => {
      const result: VirtualBatchResult = {
        success: false,
        diagnostics: [
          { filePath: "src/index.ts", line: 10, column: 5, code: 2322, message: "Type mismatch" }
        ],
        applyErrors: [],
        fileCount: 1,
        virtualFiles: new Map(),
        verifyCommand: "npx tsc --noEmit",
        verifyStdout: "Compilation failed",
        verifyStderr: ""
      };
      
      const formatted = formatVirtualBatchResult(result);
      expect(formatted).toContain("Validation failed with 1 compilation error(s)");
      expect(formatted).toContain("[src/index.ts:10:5] TS2322: Type mismatch");
      expect(formatted).toContain("Compiler stdout preview");
    });
  });

  describe("runTypeScriptCompileCheck", () => {
    it("should return success when command executes without errors", async () => {
      process.env.REI_SANDBOX_VERIFY_COMMAND = "success-cmd";
      const result = await runTypeScriptCompileCheck("/mock/workspace");
      expect(result.success).toBe(true);
      expect(result.diagnostics).toHaveLength(0);
    });

    it("should return failure and parse diagnostics when command fails", async () => {
      process.env.REI_SANDBOX_VERIFY_COMMAND = "fail-cmd";
      const result = await runTypeScriptCompileCheck("/mock/workspace");
      expect(result.success).toBe(false);
      expect(result.diagnostics).toHaveLength(1);
      expect(result.diagnostics[0].message).toBe("Fake error");
    });
    
    /**
     * This used to assert "no tsconfig.json → immediate success", which is where REI's promise
     * quietly shrank to one language: a Rust or Python workspace took that path and was reported
     * green without running anything. The gate is now the VERIFY COMMAND, so the skip happens only
     * when there is no check to run at all.
     */
    it("skips only when the project has NO verify command", async () => {
      (fs.existsSync as any).mockImplementation(() => false); // no markers at all → unknown project
      delete process.env.REI_SANDBOX_VERIFY_COMMAND;

      const result = await runTypeScriptCompileCheck("/mock/workspace");
      expect(result.success).toBe(true);
      expect(result.fileCount).toBe(0);

      (fs.existsSync as any).mockReturnValue(true);
    });

    it("still verifies a project that has a command but no tsconfig.json", async () => {
      (fs.existsSync as any).mockImplementation((p: string) => !p.includes("tsconfig.json"));
      process.env.REI_SANDBOX_VERIFY_COMMAND = "fail-cmd";

      const result = await runTypeScriptCompileCheck("/mock/workspace");
      expect(result.success).toBe(false); // it RAN, and it failed — the whole point

      delete process.env.REI_SANDBOX_VERIFY_COMMAND; // do not leak into the next test
      (fs.existsSync as any).mockReturnValue(true);
    });
  });

  describe("applyVirtualBatch", () => {
    it("should apply patches successfully and run verify command", async () => {
      process.env.REI_SANDBOX_VERIFY_COMMAND = "success-cmd";
      const edits = [
        { file: "src/index.ts", search: "const a = 1;", replace: "const a = 2;" }
      ];

      const result = await applyVirtualBatch("/mock/workspace", edits);
      
      expect(result.success).toBe(true);
      expect(result.applyErrors).toHaveLength(0);
      expect(result.virtualFiles.get("src/index.ts")).toBe("const a = 2;");
      expect(result.diagnostics).toHaveLength(0);
    });

    it("returns success without running when there is no verify command", async () => {
      (fs.existsSync as any).mockImplementation(() => false); // unknown project, nothing to run
      delete process.env.REI_SANDBOX_VERIFY_COMMAND;
      
      const edits = [
        { file: "src/index.ts", search: "const a = 1;", replace: "const a = 2;" }
      ];
      
      const result = await applyVirtualBatch("/mock/workspace", edits);
      expect(result.success).toBe(true);
      expect(result.applyErrors).toHaveLength(0);
      expect(result.virtualFiles.size).toBe(0); // exited early: nothing applied, nothing checked
      expect(result.verifyRan).toBe(false);      // and it says so, instead of passing for a green

      (fs.existsSync as any).mockReturnValue(true);
    });

    it("should fail gracefully when applyFileEdits fails (e.g. search string not found)", async () => {
      const edits = [
        { file: "src/index.ts", search: "const z = 999;", replace: "const z = 1000;" }
      ];

      const result = await applyVirtualBatch("/mock/workspace", edits);
      
      expect(result.success).toBe(false);
      expect(result.applyErrors).toHaveLength(1);
      expect(result.applyErrors[0]).toContain("Could not find exact match");
    });

    it("should fail gracefully when file cannot be read", async () => {
      const edits = [
        { file: "missing.ts", search: "const a = 1;", replace: "const a = 2;" }
      ];

      const result = await applyVirtualBatch("/mock/workspace", edits);
      
      expect(result.success).toBe(false);
      expect(result.applyErrors).toHaveLength(1);
      expect(result.applyErrors[0]).toContain("Failed to read source file missing.ts");
    });

    it("should catch compilation errors when verify command fails", async () => {
      process.env.REI_SANDBOX_VERIFY_COMMAND = "fail-cmd";
      const edits = [
        { file: "src/index.ts", search: "const a = 1;", replace: "const a = 2;" }
      ];

      const result = await applyVirtualBatch("/mock/workspace", edits);
      
      expect(result.success).toBe(false);
      expect(result.applyErrors).toHaveLength(0); // Applying patch worked
      expect(result.diagnostics).toHaveLength(1); // But compilation failed
      expect(result.diagnostics[0].message).toBe("Fake error");
    });
  });

});
});
