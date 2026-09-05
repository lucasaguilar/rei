import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectProjectType } from "./project-type.js";
import { buildFileMatcherRegex, getSourceFileExtensions } from "../language/language-capabilities.js";

/**
 * A Roblox repo keeps a package.json for its JS tooling, so the `has("package.json")` branch claimed
 * it as JavaScript. Two things followed: the model was told to write CommonJS `require`/
 * `module.exports` into a .luau codebase, and the verify command became
 * `node --check index.js 2>/dev/null || echo ok` — which prints "ok" whatever the agent writes.
 */
let ws: string;
beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), "rei-luau-"));
  mkdirSync(join(ws, "src"), { recursive: true });
});
afterEach(() => rmSync(ws, { recursive: true, force: true }));

const write = (rel: string, body = "{}") => writeFileSync(join(ws, rel), body);

describe("detectProjectType — Roblox/Luau", () => {
  it("detects a Rojo project even though it also has a package.json", () => {
    write("package.json", '{"name":"game"}');
    write("default.project.json");
    expect(detectProjectType(ws).type).toBe("luau");
  });

  it("never returns the always-passing JavaScript verify command for a Luau repo", () => {
    write("package.json", '{"name":"game"}');
    write("default.project.json");
    const { verifyCommand } = detectProjectType(ws);
    expect(verifyCommand).not.toContain("|| echo ok");
    expect(verifyCommand).toBe("rojo build --output /dev/null");
  });

  it("prefers a real Luau analyser over the Rojo build when one is configured", () => {
    write("default.project.json");
    write(".luaurc");
    expect(detectProjectType(ws).verifyCommand).toBe("luau-analyze src");
  });

  it("uses selene when that is the configured checker", () => {
    write("selene.toml", "");
    expect(detectProjectType(ws).verifyCommand).toBe("selene .");
  });

  it("detects a Luau repo from source files alone, with no config file", () => {
    write("init.luau", "print('hi')");
    expect(detectProjectType(ws).type).toBe("luau");
  });

  it("still detects TypeScript when a tsconfig is present", () => {
    // The Luau branch runs first, so a plain TS repo must not be caught by it.
    write("package.json", '{"name":"app"}');
    write("tsconfig.json");
    expect(detectProjectType(ws).type).toBe("typescript");
  });

  it("still detects JavaScript for a plain package.json project", () => {
    write("package.json", '{"name":"app"}');
    expect(detectProjectType(ws).type).toBe("javascript");
  });
});

describe("Luau files are recognised as source files", () => {
  it("matches .luau and .lua paths, which the file matcher used to reject", () => {
    // A plan's "Files to modify" is extracted with this regex: unrecognised paths meant an empty
    // file list, so a delegated stage started with nothing to edit.
    const re = buildFileMatcherRegex();
    expect("src/shared/Hello.luau".match(re)).toBeTruthy();
    expect("src/server/boxflow.server.luau".match(re)).toBeTruthy();
    expect("src/client/init.client.lua".match(re)).toBeTruthy();
  });

  it("includes them in the indexable extensions", () => {
    const exts = getSourceFileExtensions();
    expect(exts).toContain(".luau");
    expect(exts).toContain(".lua");
  });
});
