import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectProjectType } from "./project-type.js";
import { getSourceFileExtensions } from "../language/language-capabilities.js";
import { getAllowedCommands } from "../tools/sandbox-config.js";

/**
 * Every verify command here has to be a real oracle: it must FAIL on code that is wrong. A command
 * that cannot fail is worse than none, because the agent reads the pass as proof and stops looking —
 * the bug the JavaScript branch used to have (`node --check index.js … || echo ok`).
 *
 * Which is why an unconfigured toolchain falls through to no verification rather than to something
 * that always succeeds.
 */
let ws: string;
beforeEach(() => { ws = mkdtempSync(join(tmpdir(), "rei-proj-")); });
afterEach(() => rmSync(ws, { recursive: true, force: true }));

const write = (rel: string, body = "") => {
  const dir = join(ws, rel, "..");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(ws, rel), body);
};
const detect = () => detectProjectType(ws);

describe("Python — a syntax check, upgraded to a type check when the project configured one", () => {
  it("uses py_compile when nothing is configured (syntax only, and that is the honest claim)", () => {
    write("requirements.txt", "flask\n");
    write("app.py", "print(1)\n");
    expect(detect().type).toBe("python");
    expect(detect().verifyCommand).toContain("py_compile");
  });

  it("uses mypy when mypy.ini declares it", () => {
    write("pyproject.toml", "[project]\nname='x'\n");
    write("mypy.ini", "[mypy]\nstrict = true\n");
    expect(detect().verifyCommand).toBe("python3 -m mypy .");
  });

  it("uses mypy when pyproject declares [tool.mypy]", () => {
    write("pyproject.toml", "[project]\nname='x'\n\n[tool.mypy]\nstrict = true\n");
    expect(detect().verifyCommand).toBe("python3 -m mypy .");
  });

  it("uses pyright when pyrightconfig.json declares it", () => {
    write("pyproject.toml", "[project]\nname='x'\n");
    write("pyrightconfig.json", '{"typeCheckingMode":"basic"}');
    expect(detect().verifyCommand).toBe("pyright --outputjson");
  });

  it("does NOT invent a type checker for an untyped project", () => {
    // mypy on a codebase that never opted in emits hundreds of errors, verify never goes green, and
    // the agent burns its attempts on pre-existing findings it did not cause.
    write("setup.py", "from setuptools import setup\n");
    expect(detect().verifyCommand).not.toContain("mypy");
  });
});

describe("Kotlin — was silently verified with the JAVA compiler", () => {
  it("compiles Kotlin, not Java, for a Gradle Kotlin-DSL project", () => {
    // `gradle compileJava` on a .kt codebase compiles nothing and exits 0: a green light for
    // whatever the model wrote. Same family of bug as the JavaScript one.
    write("build.gradle.kts", "plugins { kotlin(\"jvm\") }\n");
    write("src/main/kotlin/Main.kt", "fun main() {}\n");
    expect(detect().type).toBe("kotlin");
    expect(detect().verifyCommand).toBe("gradle compileKotlin -q");
  });

  it("leaves a plain Java Gradle project on the Java compiler", () => {
    write("build.gradle", "apply plugin: 'java'\n");
    expect(detect().type).toBe("java");
    expect(detect().verifyCommand).toBe("gradle compileJava -q");
  });
});

describe("Swift", () => {
  it("builds a SwiftPM package", () => {
    write("Package.swift", "// swift-tools-version:5.9\n");
    expect(detect().type).toBe("swift");
    expect(detect().verifyCommand).toBe("swift build");
  });
});

describe("Dart and Flutter", () => {
  it("analyses a plain Dart package", () => {
    write("pubspec.yaml", "name: mypkg\nenvironment:\n  sdk: '>=3.0.0'\n");
    expect(detect().type).toBe("dart");
    expect(detect().verifyCommand).toBe("dart analyze");
  });

  it("uses the Flutter analyser when the pubspec depends on Flutter", () => {
    // `dart analyze` cannot resolve the Flutter SDK, so it reports import errors that are not real.
    write("pubspec.yaml", "name: myapp\ndependencies:\n  flutter:\n    sdk: flutter\n");
    expect(detect().verifyCommand).toBe("flutter analyze");
  });
});

describe("JavaScript with a jsconfig.json", () => {
  it("type-checks through tsc instead of only parsing", () => {
    write("package.json", '{"name":"x"}');
    write("jsconfig.json", '{"compilerOptions":{"checkJs":true}}');
    expect(detect().verifyCommand).toBe("npx tsc -p jsconfig.json --noEmit --pretty false");
  });

  it("falls back to the syntax check with no jsconfig", () => {
    write("package.json", '{"name":"x"}');
    expect(detect().type).toBe("javascript");
    expect(detect().verifyCommand).toContain("node --check");
  });
});

describe("an unrecognised project still gets no verification", () => {
  it("does not invent a command", () => {
    write("README.md", "# just docs\n");
    expect(detect().type).toBe("unknown");
    expect(detect().verifyCommand).toBe("echo ok");
  });
});

describe("the file matcher recognises every language REI claims to verify", () => {
  it("includes the extensions, without which plans come back with no files", () => {
    // `.java` was missing while java was a supported project type: the matcher rejected every path,
    // so "Files to modify" was empty and the repo map indexed nothing (see the Luau entry's note).
    const exts = getSourceFileExtensions();
    for (const ext of [".java", ".kt", ".swift", ".dart"]) {
      expect(exts, ext).toContain(ext);
    }
  });
});

/**
 * A verify command the sandbox refuses is worse than no verify command: the turn ends on
 * "Security Error: Command 'swift' is not in the allow-list", which reads as REI being broken rather
 * than as a missing entry. This is the invariant, not a list to keep in sync by hand.
 */
describe("every verify command REI can produce is runnable", () => {
  const fixtures: Array<[string, Record<string, string>]> = [
    ["typescript", { "tsconfig.json": "{}" }],
    ["angular", { "angular.json": "{}" }],
    ["javascript", { "package.json": "{}" }],
    ["javascript+jsconfig", { "package.json": "{}", "jsconfig.json": "{}" }],
    ["python", { "requirements.txt": "flask" }],
    ["python+mypy", { "requirements.txt": "flask", "mypy.ini": "[mypy]" }],
    ["python+pyright", { "requirements.txt": "flask", "pyrightconfig.json": "{}" }],
    ["go", { "go.mod": "module x" }],
    ["rust", { "Cargo.toml": "[package]" }],
    ["php", { "composer.json": "{}" }],
    ["java", { "pom.xml": "<project/>" }],
    ["java+gradle", { "build.gradle": "" }],
    ["kotlin", { "build.gradle.kts": "" }],
    ["swift", { "Package.swift": "" }],
    ["dart", { "pubspec.yaml": "name: x" }],
    ["flutter", { "pubspec.yaml": "dependencies:\n  flutter:\n    sdk: flutter" }],
    ["csharp", { "Directory.Build.props": "<Project/>" }],
  ];

  it.each(fixtures)("%s", (_name, files) => {
    for (const [rel, body] of Object.entries(files)) write(rel, body);
    const cmd = detect().verifyCommand;
    const binary = cmd.trim().split(/\s+/)[0];
    expect(getAllowedCommands(), `${binary} (from: ${cmd})`).toContain(binary);
  });
});
