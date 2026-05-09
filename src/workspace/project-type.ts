import * as fs from "fs";
import * as path from "path";

export type ProjectType = "angular" | "typescript" | "csharp" | "unknown";

export interface ProjectDetection {
  type: ProjectType;
  verifyCommand: string;
}

/**
 * Detects the project type and returns the recommended verify command.
 */
export function detectProjectType(workspacePath: string): ProjectDetection {
  let command = "npx tsc --noEmit --pretty false";
  let type: ProjectType = "unknown";

  // Angular: angular.json in root
  if (fs.existsSync(path.join(workspacePath, "angular.json"))) {
    type = "angular";
    command = "npx ng build --configuration=production --no-progress --output-hashing=none";
  }
  // TypeScript: tsconfig.json in root
  else if (fs.existsSync(path.join(workspacePath, "tsconfig.json"))) {
    type = "typescript";
    command = "npx tsc --noEmit --pretty false";
  }
  // C#: .csproj or .sln in root
  else if (
    fs.existsSync(path.join(workspacePath, "Directory.Build.props")) ||
    fs.readdirSync(workspacePath).some((file) =>
      file.endsWith(".csproj") || file.endsWith(".sln")
    )
  ) {
    type = "csharp";
    command = "dotnet build";
  }

  // TDD Mode Injection
  if (process.env.REI_TDD_MODE === "true") {
    const pkgPath = path.join(workspacePath, "package.json");
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
        if (pkg.scripts && pkg.scripts.test) {
          command = `${command} && npm run test`;
        }
      } catch (e) {
        // ignore parse error
      }
    }
  }

  return {
    type,
    verifyCommand: command,
  };
}
