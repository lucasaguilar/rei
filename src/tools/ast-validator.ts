import { Project } from "ts-morph";
import * as path from "path";
import * as fs from "fs";
import { execSync } from "child_process";

export interface AstValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Validates a patch by applying it securely to a temporary copy of the file
 * and running the TypeScript Compiler internally via ts-morph.
 */
export async function validatePatchAst(
  patchText: string,
  targetFile: string,
  workspacePath: string
): Promise<AstValidationResult> {
  const fullTargetPath = path.resolve(workspacePath, targetFile);
  if (!fs.existsSync(fullTargetPath)) {
    return { valid: false, errors: [`File not found: ${targetFile}`] };
  }

  // 1. Create a secure temporary clone of the file to apply the patch
  const tmpDir = path.join(workspacePath, ".tmp-ast");
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
  
  const tmpFilePath = path.join(tmpDir, path.basename(targetFile));
  fs.copyFileSync(fullTargetPath, tmpFilePath);
  const tmpPatchPath = path.join(tmpDir, "temp.patch");
  
  // Rewire the patch headers to point to our temp file instead of the real one
  const rewiredPatch = patchText
    .replace(`--- a/${targetFile}`, `--- a/${path.basename(targetFile)}`)
    .replace(`+++ b/${targetFile}`, `+++ b/${path.basename(targetFile)}`);
  
  fs.writeFileSync(tmpPatchPath, rewiredPatch);

  try {
    // 2. Apply patch to the temp file only
    execSync(`git apply temp.patch`, { cwd: tmpDir, stdio: "pipe" });
    const patchedText = fs.readFileSync(tmpFilePath, "utf8");

    // 3. Load the REAL file path into ts-morph Project to preserve relative imports
    const tsconfigPath = path.join(workspacePath, "tsconfig.json");
    const project = new Project({
      tsConfigFilePath: fs.existsSync(tsconfigPath) ? tsconfigPath : undefined,
      skipAddingFilesFromTsConfig: true,
      compilerOptions: {
        allowJs: true,
        checkJs: true,
      },
    });

    const sourceFile = project.addSourceFileAtPath(fullTargetPath);
    sourceFile.replaceWithText(patchedText); // In-memory update
    
    // 4. Run the TypeScript Compiler semantics
    const diagnostics = sourceFile.getPreEmitDiagnostics();
    const errors: string[] = [];

    for (const diag of diagnostics) {
      const msg = diag.getMessageText();
      const code = diag.getCode();
      const messageStr = typeof msg === "string" ? msg : msg.getMessageText();
      errors.push(`TS${code}: ${messageStr}`);
    }

    return {
      valid: errors.length === 0,
      errors
    };

  } catch (err) {
    return { valid: false, errors: ["Patch failed to apply cleanly to AST temp file.", (err as Error).message] };
  } finally {
    // Cleanup
    if (fs.existsSync(tmpFilePath)) fs.unlinkSync(tmpFilePath);
    if (fs.existsSync(tmpPatchPath)) fs.unlinkSync(tmpPatchPath);
  }
}
