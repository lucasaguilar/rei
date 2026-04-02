import { Project } from "ts-morph";
import * as path from "path";
import * as fs from "fs";
import { execSync } from "child_process";

export interface TypeScriptAstValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Tier 1 semantic patch validation for TypeScript/JavaScript files.
 *
 * This validator applies a patch to a temporary file copy and runs the
 * TypeScript compiler in memory via ts-morph. It is intentionally scoped to
 * TypeScript/JavaScript semantics; other languages currently rely on text-level
 * patch validation and git applicability checks.
 */
export async function validateTypeScriptPatchAst(
  patchText: string,
  targetFile: string,
  workspacePath: string,
): Promise<TypeScriptAstValidationResult> {
  const fullTargetPath = path.resolve(workspacePath, targetFile);
  if (!fs.existsSync(fullTargetPath)) {
    return { valid: false, errors: [`File not found: ${targetFile}`] };
  }

  const tmpDir = path.join(workspacePath, ".tmp-ast");
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

  const tmpFilePath = path.join(tmpDir, path.basename(targetFile));
  fs.copyFileSync(fullTargetPath, tmpFilePath);
  const tmpPatchPath = path.join(tmpDir, "temp.patch");

  const rewiredPatch = patchText
    .replace(`--- a/${targetFile}`, `--- a/${path.basename(targetFile)}`)
    .replace(`+++ b/${targetFile}`, `+++ b/${path.basename(targetFile)}`);

  fs.writeFileSync(tmpPatchPath, rewiredPatch);

  try {
    execSync(`git apply temp.patch`, { cwd: tmpDir, stdio: "pipe" });
    const patchedText = fs.readFileSync(tmpFilePath, "utf8");

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
    sourceFile.replaceWithText(patchedText);

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
      errors,
    };
  } catch (err) {
    return {
      valid: false,
      errors: [
        "Patch failed to apply cleanly to AST temp file.",
        (err as Error).message,
      ],
    };
  } finally {
    if (fs.existsSync(tmpFilePath)) fs.unlinkSync(tmpFilePath);
    if (fs.existsSync(tmpPatchPath)) fs.unlinkSync(tmpPatchPath);
  }
}
