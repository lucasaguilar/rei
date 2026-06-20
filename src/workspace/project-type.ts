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
  const hasExt = (ext: string): boolean => {
    try {
      return fs.readdirSync(workspacePath).some((f) => f.endsWith(ext));
    } catch {
      return false;
    }
  };

  let type: ProjectType = "unknown";
  let command = SKIP_VERIFY;

  if (has("angular.json")) {
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
    command = "node --check index.js 2>/dev/null || echo ok";
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
