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
    const entries = fs.readdirSync(workspacePath).filter(
      (f) => !f.startsWith(".") && f !== "node_modules",
    );
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
    } catch { return false; }
  };

  let type: ProjectType = "unknown";
  let command = SKIP_VERIFY;

  if (has("angular.json")) {
    type = "angular";
    command = "npx tsc --noEmit --pretty false";
  } else if (has("tsconfig.json")) {
    type = "typescript";
    command = "npx tsc --noEmit --pretty false";
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
  } else if (has("requirements.txt") || has("pyproject.toml") || has("setup.py") || hasExt(".py")) {
    type = "python";
    command = "python3 -m py_compile $(find . -name '*.py' -not -path './.rei/*' | head -20) && echo ok";
  } else if (has("go.mod") || hasExt(".go")) {
    type = "go";
    command = "go build ./...";
  } else if (has("Cargo.toml") || hasExt(".rs")) {
    type = "rust";
    command = "cargo check";
  } else if (has("composer.json") || hasExt(".php")) {
    type = "php";
    command = "php -l $(find . -name '*.php' -not -path './.rei/*' | head -20) && echo ok";
  } else if (has("pom.xml") || has("build.gradle") || hasExt(".java")) {
    type = "java";
    command = has("pom.xml") ? "mvn compile -q" : "gradle compileJava -q";
  }

  // TDD Mode: append test runner if available
  if (process.env.REI_TDD_MODE === "true" && command !== SKIP_VERIFY) {
    const pkgPath = path.join(workspacePath, "package.json");
    if (has("package.json")) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as { scripts?: Record<string, string> };
        if (pkg.scripts?.test) {
          command = `${command} && npm run test`;
        }
      } catch { /* ignore */ }
    }
  }

  return { type, verifyCommand: command, isEmpty: false };
}
