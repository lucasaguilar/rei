import * as fs from "fs";
import * as path from "path";

export type ProjectType = "angular" | "typescript" | "unknown";

export interface ProjectDetection {
  type: ProjectType;
  verifyCommand: string;
}

/**
 * Detects the project type and returns the recommended verify command.
 */
export function detectProjectType(workspacePath: string): ProjectDetection {
  // Angular: angular.json in root
  if (fs.existsSync(path.join(workspacePath, "angular.json"))) {
    return {
      type: "angular",
      verifyCommand:
        "npx ng build --configuration=production --no-progress --output-hashing=none",
    };
  }
  // TypeScript: tsconfig.json in root
  if (fs.existsSync(path.join(workspacePath, "tsconfig.json"))) {
    return {
      type: "typescript",
      verifyCommand: "npx tsc --noEmit --pretty false",
    };
  }
  return {
    type: "unknown",
    verifyCommand: "npx tsc --noEmit --pretty false",
  };
}
