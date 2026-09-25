import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { generateRepoMapForFile } from "./repo-map-generator.js";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

describe("repo-map-generator (AST Extraction Quality)", () => {
  let tmpWorkspace: string;

  beforeAll(async () => {
    // Create a real temporary workspace to avoid ts-morph mock conflicts
    tmpWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), "rei-ast-test-"));

    // 1. Create a TypeScript file with complex AST structures
    const tsContent = `
import { SomeDependency } from "./dependency.ts";

/** 
 * This is an important JSDoc comment the LLM is meant to read.
 */
export interface UserData {
  id: string;
  age?: number;
}

// [exported]
export type Status = "active" | "inactive";

/** Servicio de Usuarios */
export class UserService implements BaseService {
  public static readonly VERSION = "1.0";
  private internalToken: string;

  /** Obtiene un usuario */
  public async getUser(id: string): Promise<UserData> {
    return { id };
  }
}

export function helperFunction(a: number): string {
  return a.toString();
}
    `;
    await fs.writeFile(path.join(tmpWorkspace, "user.ts"), tsContent);

    // 2. Create an HTML file (Angular/Web component style)
    const htmlContent = `
<div class="container">
  <my-custom-header [title]="'Hello'"></my-custom-header>
  <span class="badge">New</span>
  <ion-button>Click Me</ion-button>
</div>
    `;
    await fs.writeFile(path.join(tmpWorkspace, "view.html"), htmlContent);

    // 3. Create a CSS file
    const cssContent = `
.container { display: flex; }
.badge-red { color: red; }
#main-form { padding: 10px; }
    `;
    await fs.writeFile(path.join(tmpWorkspace, "styles.css"), cssContent);

    // 4. Create a Test file
    const testContent = `
describe('UserService', () => {
  it('should return a user', () => {});
  test('should fail if user not found', () => {});
});
    `;
    await fs.writeFile(path.join(tmpWorkspace, "user.test.ts"), testContent);

    // 5. Polyglot source files for Tree-sitter integration tests
    await fs.writeFile(
      path.join(tmpWorkspace, "script.py"),
      `def process_data(items: list) -> dict:\n    result = {}\n    return result\n\nclass DataProcessor:\n    def __init__(self, config: dict):\n        self.config = config\n`,
    );

    await fs.writeFile(
      path.join(tmpWorkspace, "main.c"),
      `#include <stdio.h>\n\nint add(int a, int b) {\n    return a + b;\n}\n\nstruct Point {\n    int x;\n    int y;\n};\n`,
    );

    await fs.writeFile(
      path.join(tmpWorkspace, "Repository.cs"),
      `using System;\n\nnamespace MyApp {\n    public class Repository {\n        private readonly string _prefix = "repo";\n        public string Prefix { get; set; }\n\n        public string GetById(int id) {\n            return _prefix + id;\n        }\n    }\n}\n`,
    );

    await fs.writeFile(
      path.join(tmpWorkspace, "lib.rs"),
      `pub fn compute(x: i32, y: i32) -> i32 {\n    x + y\n}\n\npub struct Config {\n    pub name: String,\n}\n`,
    );

    await fs.writeFile(
      path.join(tmpWorkspace, "service.go"),
      `package main\n\ntype Service struct {\n    Name string\n}\n\nfunc (s Service) Process(input string) string {\n    return s.Name + input\n}\n`,
    );
  }, 30_000);

  afterAll(async () => {
    // Cleanup
    await fs.rm(tmpWorkspace, { recursive: true, force: true });
  });

  it("should extract high-quality AST chunks from TypeScript files", async () => {
    const output = await generateRepoMapForFile(tmpWorkspace, path.join(tmpWorkspace, "user.ts"));

    expect(output).not.toBeNull();

    // Check Imports
    expect(output).toContain("// Imports: ./dependency.ts");

    // Check Interfaces & JSDoc
    expect(output).toContain("// This is an important JSDoc comment");
    expect(output).toContain("export interface UserData");
    expect(output).toContain("id: string;");
    expect(output).toContain("age?: number;");

    // Check Types
    expect(output).toContain('export type Status = "active" | "inactive";');

    // Check Classes, Modifiers & JSDoc
    expect(output).toContain("// Servicio de Usuarios");
    expect(output).toContain("export class UserService implements BaseService");
    expect(output).toContain("public static readonly VERSION: any;");

    // Private properties should NOT be exposed in the AST skeleton
    expect(output).not.toContain("internalToken");

    // Check Methods & JSDoc
    expect(output).toContain("// Obtiene un usuario");
    expect(output).toContain("public async getUser(id: string): Promise<");
    expect(output).toContain("UserData>");

    // Check standard functions
    expect(output).toContain("export function helperFunction(a: number): string;");
  });

  it("should extract relevant semantic tags from HTML files", async () => {
    const output = await generateRepoMapForFile(tmpWorkspace, path.join(tmpWorkspace, "view.html"));

    expect(output).not.toBeNull();

    // Should extract custom/semantic tags
    expect(output).toContain("my-custom-header");
    expect(output).toContain("ion-button");

    // Should ignore generic layout tags (div, span)
    expect(output).not.toContain("div");
    expect(output).not.toContain("span");
  });

  it("should extract classes and IDs from CSS/SCSS files", async () => {
    const output = await generateRepoMapForFile(tmpWorkspace, path.join(tmpWorkspace, "styles.css"));

    expect(output).not.toBeNull();
    expect(output).toContain("CSS classes: container, badge-red");
    expect(output).toContain("CSS ids: main-form");
  });

  it("should extract test suites and cases from Spec/Test files", async () => {
    const output = await generateRepoMapForFile(tmpWorkspace, path.join(tmpWorkspace, "user.test.ts"));

    expect(output).not.toBeNull();
    expect(output).toContain("Test suites: UserService");
    expect(output).toContain("Test cases: should return a user, should fail if user not found");
  });

  it("should ignore prohibited directories like node_modules", async () => {
    const output = await generateRepoMapForFile(
      tmpWorkspace,
      path.join(tmpWorkspace, "node_modules", "package", "index.ts"),
    );
    expect(output).toBeNull();
  });

  // --- Polyglot (Tree-sitter) integration tests ---
  // These tests verify that the Hybrid AST engine uses Tree-sitter (not local regex)
  // for polyglot files. A regression to regex/raw-text would break these assertions.

  it("should extract Python functions and classes via Tree-sitter", async () => {
    const output = await generateRepoMapForFile(tmpWorkspace, path.join(tmpWorkspace, "script.py"));

    expect(output).not.toBeNull();
    // Verify structural skeleton is extracted
    expect(output).toContain("def process_data(items: list) -> dict:");
    expect(output).toContain("class DataProcessor {");
    expect(output).toContain("def __init__(self, config: dict):");
    // Must NOT use the old regex "Symbols: ..." format
    expect(output).not.toMatch(/^Symbols:/m);
  }, 15_000);

  it("should extract C functions and structs via Tree-sitter", async () => {
    const output = await generateRepoMapForFile(tmpWorkspace, path.join(tmpWorkspace, "main.c"));

    expect(output).not.toBeNull();
    expect(output).toContain("int add(int a, int b);");
    expect(output).toContain("struct Point {");
    expect(output).toContain("int x;");
    expect(output).toContain("int y;");
    expect(output).not.toMatch(/^Symbols:/m);
  }, 15_000);

  it("should extract C# classes and methods via Tree-sitter", async () => {
    const output = await generateRepoMapForFile(tmpWorkspace, path.join(tmpWorkspace, "Repository.cs"));

    expect(output).not.toBeNull();
    expect(output).toContain("namespace MyApp {");
    expect(output).toContain("class Repository {");
    expect(output).toContain("public string Prefix");
    expect(output).toContain("public string GetById(int id)");
    expect(output).not.toMatch(/^Symbols:/m);
  }, 15_000);

  it("should extract Rust functions and structs via Tree-sitter", async () => {
    const output = await generateRepoMapForFile(tmpWorkspace, path.join(tmpWorkspace, "lib.rs"));

    expect(output).not.toBeNull();
    expect(output).toContain("pub fn compute(x: i32, y: i32) -> i32;");
    expect(output).toContain("struct Config {");
    expect(output).not.toMatch(/^Symbols:/m);
  }, 15_000);

  it("should extract Go methods and struct fields via Tree-sitter", async () => {
    const output = await generateRepoMapForFile(tmpWorkspace, path.join(tmpWorkspace, "service.go"));

    expect(output).not.toBeNull();
    expect(output).toContain("type Service {");
    expect(output).toContain("Name string;");
    expect(output).toContain("func (s Service) Process(input string) string;");
    expect(output).not.toMatch(/^Symbols:/m);
  }, 15_000);
});
