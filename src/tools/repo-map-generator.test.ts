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
 * Este es un comentario JSDoc importante que el LLM debe leer.
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
  });

  afterAll(async () => {
    // Cleanup
    await fs.rm(tmpWorkspace, { recursive: true, force: true });
  });

  it("should extract high-quality AST chunks from TypeScript files", () => {
    const output = generateRepoMapForFile(tmpWorkspace, path.join(tmpWorkspace, "user.ts"));
    
    expect(output).not.toBeNull();
    
    // Check Imports
    expect(output).toContain('// Imports: ./dependency.ts');
    
    // Check Interfaces & JSDoc
    expect(output).toContain('// Este es un comentario JSDoc importante');
    expect(output).toContain('export interface UserData');
    expect(output).toContain('id: string;');
    expect(output).toContain('age?: number;');
    
    // Check Types
    expect(output).toContain('export type Status = "active" | "inactive";');
    
    // Check Classes, Modifiers & JSDoc
    expect(output).toContain('// Servicio de Usuarios');
    expect(output).toContain('export class UserService implements BaseService');
    expect(output).toContain('public static readonly VERSION: any;');
    
    // Private properties should NOT be exposed in the AST skeleton
    expect(output).not.toContain('internalToken');
    
    // Check Methods & JSDoc
    expect(output).toContain('// Obtiene un usuario');
    expect(output).toContain('public async getUser(id: string): Promise<');
    expect(output).toContain('UserData>');
    
    // Check standard functions
    expect(output).toContain('export function helperFunction(a: number): string;');
  });

  it("should extract relevant semantic tags from HTML files", () => {
    const output = generateRepoMapForFile(tmpWorkspace, path.join(tmpWorkspace, "view.html"));
    
    expect(output).not.toBeNull();
    
    // Should extract custom/semantic tags
    expect(output).toContain('my-custom-header');
    expect(output).toContain('ion-button');
    
    // Should ignore generic layout tags (div, span)
    expect(output).not.toContain('div');
    expect(output).not.toContain('span');
  });

  it("should extract classes and IDs from CSS/SCSS files", () => {
    const output = generateRepoMapForFile(tmpWorkspace, path.join(tmpWorkspace, "styles.css"));
    
    expect(output).not.toBeNull();
    expect(output).toContain('CSS classes: container, badge-red');
    expect(output).toContain('CSS ids: main-form');
  });

  it("should extract test suites and cases from Spec/Test files", () => {
    const output = generateRepoMapForFile(tmpWorkspace, path.join(tmpWorkspace, "user.test.ts"));
    
    expect(output).not.toBeNull();
    expect(output).toContain('Test suites: UserService');
    expect(output).toContain('Test cases: should return a user, should fail if user not found');
  });

  it("should ignore prohibited directories like node_modules", () => {
    const output = generateRepoMapForFile(tmpWorkspace, path.join(tmpWorkspace, "node_modules", "package", "index.ts"));
    expect(output).toBeNull();
  });
});
