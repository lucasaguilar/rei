import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { TypeScriptCompileAdapter } from "../../tools/adapters/typescript-compile-adapter.js";
import { CSharpCompileAdapter } from "../../tools/adapters/csharp-compile-adapter.js";
import type { GenericDiagnostic } from "../../tools/compile-check-core.js";

/**
 * Per-adapter `resolveReferencedFiles`: reproduces the consumer→provider loop bug, where the
 * model edits a CONSUMER importing a not-yet-added symbol, so the compile error appears IN the
 * (edited) consumer but names the PROVIDER module. The agnostic `d.filePath` check (handled by
 * the caller) missed the provider; the TS adapter now recovers it from the error message.
 */
describe("TypeScriptCompileAdapter.resolveReferencedFiles", () => {
  const ts = new TypeScriptCompileAdapter();
  let ws: string;

  const diag = (over: Partial<GenericDiagnostic>): GenericDiagnostic => ({
    filePath: "src/app/settings/settings.component.ts",
    line: 1,
    column: 1,
    code: 2305,
    message: "",
    ...over,
  });

  beforeEach(() => {
    ws = fs.mkdtempSync(path.join(os.tmpdir(), "rei-extra-files-"));
    fs.mkdirSync(path.join(ws, "src/app/settings"), { recursive: true });
    fs.writeFileSync(path.join(ws, "src/app/settings/api-config-new.ts"), "export const X = 1;\n");
    fs.writeFileSync(
      path.join(ws, "src/app/settings/settings.component.ts"),
      "import { API_CONFIG_NEW } from './api-config-new';\n",
    );
  });

  afterEach(() => fs.rmSync(ws, { recursive: true, force: true }));

  it("resolves the provider module named in a TS2305 error inside the edited consumer", () => {
    expect(
      ts.resolveReferencedFiles(ws, [
        diag({ message: `Module '"./api-config-new"' has no exported member 'API_CONFIG_NEW'.` }),
      ]),
    ).toEqual(["src/app/settings/api-config-new.ts"]);
  });

  it("resolves TS2307 'Cannot find module' relative specifiers", () => {
    expect(
      ts.resolveReferencedFiles(ws, [
        diag({ code: 2307, message: `Cannot find module './api-config-new' or its corresponding type declarations.` }),
      ]),
    ).toEqual(["src/app/settings/api-config-new.ts"]);
  });

  it("ignores node_modules packages and unrelated error codes", () => {
    expect(
      ts.resolveReferencedFiles(ws, [
        diag({ message: `Module '@angular/core' has no exported member 'Foo'.` }),
        diag({ code: 2339, message: `Property 'bar' does not exist on type 'X'.` }),
      ]),
    ).toEqual([]);
  });

  it("does not return specifiers that don't resolve to a real workspace file", () => {
    expect(
      ts.resolveReferencedFiles(ws, [
        diag({ code: 2307, message: `Cannot find module './does-not-exist'.` }),
      ]),
    ).toEqual([]);
  });
});

describe("CSharpCompileAdapter.resolveReferencedFiles", () => {
  it("returns [] (C# uses namespaces, not relative file imports) — falls back to d.filePath", () => {
    const cs = new CSharpCompileAdapter();
    expect(
      cs.resolveReferencedFiles("/ws", [
        { filePath: "Foo.cs", line: 1, column: 1, code: 246, message: "CS0246: The type or namespace name 'Bar' could not be found" },
      ]),
    ).toEqual([]);
  });
});
