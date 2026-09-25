import * as fs from "fs";
import * as path from "path";

export type ProjectType =
  | "angular"
  | "typescript"
  | "javascript"
  | "csharp"
  | "python"
  | "go"
  | "rust"
  | "php"
  | "java"
  | "kotlin"
  | "swift"
  | "dart"
  | "luau"
  | "empty"
  | "unknown";

export interface ProjectDetection {
  type: ProjectType;
  verifyCommand: string;
  isEmpty: boolean;
}

const SKIP_VERIFY = "echo ok";

/**
 * Returns true when the workspace has no meaningful source files yet.
 * Ignores .rei/, .git/, node_modules/, and hidden files.
 */
function isWorkspaceEmpty(workspacePath: string): boolean {
  try {
    const entries = fs
      .readdirSync(workspacePath)
      .filter((f) => !f.startsWith(".") && f !== "node_modules");
    if (entries.length === 0) return true;
    // Only .rei directory → still empty from a project perspective
    if (entries.length === 1 && entries[0] === ".rei") return true;
    return false;
  } catch {
    return true;
  }
}

/**
 * Detects the project type based on config files and returns the
 * recommended verify command. Returns SKIP_VERIFY for empty or
 * unrecognized workspaces so REI never runs tsc on a non-TS project.
 */
export function detectProjectType(workspacePath: string): ProjectDetection {
  const isEmpty = isWorkspaceEmpty(workspacePath);
  if (isEmpty) {
    return { type: "empty", verifyCommand: SKIP_VERIFY, isEmpty: true };
  }

  const has = (file: string) => fs.existsSync(path.join(workspacePath, file));
  /** Whether a config file exists AND contains `needle` — for "did this project opt in?" checks. */
  const declares = (file: string, needle: RegExp): boolean => {
    try {
      return needle.test(fs.readFileSync(path.join(workspacePath, file), "utf8"));
    } catch {
      return false;
    }
  };
  const hasExt = (ext: string): boolean => {
    try {
      return fs.readdirSync(workspacePath).some((f) => f.endsWith(ext));
    } catch {
      return false;
    }
  };

  let type: ProjectType = "unknown";
  let command = SKIP_VERIFY;

  // Roblox/Luau BEFORE the package.json branch: these repos routinely carry a package.json for
  // JS tooling, and matching it first told the model the project was JavaScript — so it was
  // instructed to write CommonJS `require`/`module.exports` into a .luau codebase.
  if (
    has("default.project.json") ||
    has(".luaurc") ||
    has("selene.toml") ||
    hasExt(".luau")
  ) {
    type = "luau";
    // Only real checkers. `rojo build` parses every source file and fails on a syntax error, so it
    // is a genuine oracle even without a Luau analyser installed. When none of them is configured
    // we fall through to SKIP_VERIFY rather than invent a command: the JavaScript branch's
    // `node --check index.js 2>/dev/null || echo ok` ALWAYS printed ok, which is worse than no
    // verification at all — the agent got a green light no matter what it wrote.
    if (has(".luaurc")) command = "luau-analyze src";
    else if (has("selene.toml")) command = "selene .";
    else if (has("default.project.json")) command = "rojo build --output /dev/null";
  } else if (has("angular.json")) {
    type = "angular";
    // Use the Angular compiler (ngc), NOT bare tsc: tsc type-checks .ts files but
    // is blind to template errors (e.g. NG5002 in .html) — it would pass a broken
    // template and report a false "verified". ngc compiles templates too and is
    // ~1s (vs ~1min for `ng build`). Point it at the app project tsconfig, since
    // the root tsconfig.json is solution-style ("files": []) and checks nothing.
    command = has("tsconfig.app.json")
      ? "npx ngc -p tsconfig.app.json --noEmit"
      : "npx ngc --noEmit";
  } else if (has("tsconfig.json")) {
    type = "typescript";
    // Use tsconfig.build.json (excludes test files) if present, otherwise use default tsconfig.json.
    // This prevents test files from causing validation failures in the agent sandbox when their
    // imports reference symbols the agent just modified/removed in production code.
    const tsconfigPath = has("tsconfig.build.json")
      ? "tsconfig.build.json"
      : "tsconfig.json";
    command = `npx tsc -p ${tsconfigPath} --noEmit --pretty false`;
  } else if (has("package.json") || has("index.js") || has("index.mjs")) {
    type = "javascript";
    // A `jsconfig.json` is the project saying "check my JavaScript": tsc reads it (including
    // `checkJs`) and reports real type errors, which beats parsing every file. Only when it is
    // absent do we fall back to the syntax scan below.
    if (has("jsconfig.json")) {
      return {
        type,
        verifyCommand: "npx tsc -p jsconfig.json --noEmit --pretty false",
        isEmpty: false,
      };
    }
    // Plain JavaScript has no type checker, so this is a SYNTAX check over the files that exist —
    // which is the strongest honest claim available for the language.
    //
    // It replaces `node --check index.js 2>/dev/null || echo ok`, which checked one hard-coded file
    // that usually was not there, swallowed the error, and printed "ok". A project with a syntax
    // error verified green. A verify command that cannot fail is worse than none: the agent takes
    // the pass as proof and stops looking.
    command =
      "find . -name '*.js' -not -path './node_modules/*' -not -path './.rei/*' " +
      "-not -path './dist/*' | head -50 | xargs -I{} node --check {}";
  } else if (
    has("Directory.Build.props") ||
    hasExt(".csproj") ||
    hasExt(".sln")
  ) {
    type = "csharp";
    command = "dotnet build";
  } else if (
    has("requirements.txt") ||
    has("pyproject.toml") ||
    has("setup.py") ||
    hasExt(".py")
  ) {
    type = "python";
    // A configured type checker is a real oracle; py_compile only proves the file parses. We use one
    // ONLY when the project declared it: running mypy over a codebase that never opted in reports
    // hundreds of pre-existing errors, verify never reaches green, and the agent spends its two
    // attempts on findings it did not cause.
    const declaresMypy =
      has("mypy.ini") ||
      has(".mypy.ini") ||
      declares("pyproject.toml", /^\s*\[tool\.mypy\]/m) ||
      declares("setup.cfg", /^\s*\[mypy\]/m);
    const declaresPyright =
      has("pyrightconfig.json") || declares("pyproject.toml", /^\s*\[tool\.pyright\]/m);
    if (declaresMypy) command = "python3 -m mypy .";
    else if (declaresPyright) command = "pyright --outputjson";
    else
      command =
        "python3 -m py_compile $(find . -name '*.py' -not -path './.rei/*' | head -20) && echo ok";
  } else if (has("go.mod") || hasExt(".go")) {
    type = "go";
    command = "go build ./...";
  } else if (has("Cargo.toml") || hasExt(".rs")) {
    type = "rust";
    command = "cargo check";
  } else if (has("composer.json") || hasExt(".php")) {
    type = "php";
    command =
      "php -l $(find . -name '*.php' -not -path './.rei/*' | head -20) && echo ok";
  } else if (has("Package.swift")) {
    type = "swift";
    // SwiftPM builds the whole package and fails on a type error. An .xcodeproj deliberately gets
    // nothing: xcodebuild needs a scheme we cannot guess, and guessing wrong means a false pass.
    command = "swift build";
  } else if (has("pubspec.yaml")) {
    type = "dart";
    // `dart analyze` is a real static analysis (type errors included), but it cannot resolve the
    // Flutter SDK — on a Flutter app it reports import errors that are not real. So the pubspec
    // decides which analyser runs.
    command = declares("pubspec.yaml", /flutter/i) ? "flutter analyze" : "dart analyze";
  } else if (has("build.gradle.kts") || hasExt(".kt")) {
    // BEFORE java: a Kotlin project carries build.gradle(.kts), matched the java branch, and was
    // verified with `gradle compileJava` — which compiles no Kotlin and exits 0. A green light for
    // anything the model wrote, the same failure the JavaScript branch used to have.
    type = "kotlin";
    command = "gradle compileKotlin -q";
  } else if (has("pom.xml") || has("build.gradle") || hasExt(".java")) {
    type = "java";
    command = has("pom.xml") ? "mvn compile -q" : "gradle compileJava -q";
  }

  // TDD Mode: append test runner if available
  if (process.env.REI_TDD_MODE === "true" && command !== SKIP_VERIFY) {
    const pkgPath = path.join(workspacePath, "package.json");
    if (has("package.json")) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as {
          scripts?: Record<string, string>;
        };
        if (pkg.scripts?.test) {
          command = `${command} && npm run test`;
        }
      } catch {
        /* ignore */
      }
    }
  }

  return { type, verifyCommand: command, isEmpty: false };
}
