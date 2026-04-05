import { Project } from "ts-morph";
import * as path from "path";
import * as fs from "fs";
import { execSync } from "child_process";

export interface TypeScriptAstValidationResult {
  valid: boolean;
  errors: string[];
}

export interface AstValidationOptions {
  /** Workspace-relative paths of files being created in the same batch. */
  createTargets?: Set<string>;
  /**
   * Pre-computed batch AST results keyed by workspace-relative file path.
   * When present, `validateWithAstGuard` skips individual AST validation and
   * uses these results directly. Populated by `validateTypeScriptPatchBatch`.
   */
  batchResults?: Map<string, TypeScriptAstValidationResult>;
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
  options?: AstValidationOptions,
): Promise<TypeScriptAstValidationResult> {
  const fullTargetPath = path.resolve(workspacePath, targetFile);
  const isCreatePatch = patchText.trimStart().startsWith("--- /dev/null");

  if (!isCreatePatch && !fs.existsSync(fullTargetPath)) {
    return { valid: false, errors: [`File not found: ${targetFile}`] };
  }

  // For create patches: extract content directly from patch lines.
  // Avoids running `git apply` which fails with "already exists" if the temp file
  // was left over from a previous (crashed) run.
  if (isCreatePatch) {
    const patchedText = extractCreatePatchContent(patchText);
    return validateSourceText(
      patchedText,
      fullTargetPath,
      targetFile,
      workspacePath,
      options,
    );
  }

  // For modification patches: apply via git apply in a temp dir.
  const tmpDir = path.join(workspacePath, ".tmp-ast");
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

  const tmpFilePath = path.join(tmpDir, path.basename(targetFile));
  const tmpPatchPath = path.join(tmpDir, "temp.patch");

  fs.copyFileSync(fullTargetPath, tmpFilePath);

  const rewiredPatch = patchText
    .replace(`--- a/${targetFile}`, `--- a/${path.basename(targetFile)}`)
    .replace(`+++ b/${targetFile}`, `+++ b/${path.basename(targetFile)}`);

  fs.writeFileSync(tmpPatchPath, rewiredPatch);

  try {
    execSync(`git apply temp.patch`, { cwd: tmpDir, stdio: "pipe" });
    const patchedText = fs.readFileSync(tmpFilePath, "utf8");
    return validateSourceText(
      patchedText,
      fullTargetPath,
      targetFile,
      workspacePath,
      options,
    );
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

/**
 * Validate a batch of patches together in a single ts-morph Project.
 *
 * Validates all TS/JS patches at once so cross-file type references resolve
 * correctly — e.g. File A importing a type from newly-created File B.
 * Returns a Map keyed by workspace-relative file path.
 */
export async function validateTypeScriptPatchBatch(
  patches: Array<{ patchText: string; targetFile: string }>,
  workspacePath: string,
  extraCreateTargets?: Set<string>,
): Promise<Map<string, TypeScriptAstValidationResult>> {
  const results = new Map<string, TypeScriptAstValidationResult>();
  const createTargets = new Set<string>(extraCreateTargets ?? []);
  const patchContents = new Map<string, string>();
  const tmpFiles: string[] = [];

  const tmpDir = path.join(workspacePath, ".tmp-ast");
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

  // Pass 1: resolve each patch to its "after" content.
  for (const { patchText, targetFile } of patches) {
    const fullTargetPath = path.resolve(workspacePath, targetFile);
    const isCreatePatch = patchText.trimStart().startsWith("--- /dev/null");

    if (isCreatePatch) {
      createTargets.add(targetFile);
      patchContents.set(targetFile, extractCreatePatchContent(patchText));
      continue;
    }

    if (!fs.existsSync(fullTargetPath)) {
      results.set(targetFile, {
        valid: false,
        errors: [`File not found: ${targetFile}`],
      });
      continue;
    }

    // Use a safe basename to avoid collisions (e.g. two files named index.ts).
    const safeBasename = targetFile.replace(/[\/\\]/g, "__");
    const tmpFilePath = path.join(tmpDir, safeBasename);
    const tmpPatchPath = path.join(tmpDir, `${safeBasename}.patch`);
    tmpFiles.push(tmpFilePath, tmpPatchPath);

    fs.copyFileSync(fullTargetPath, tmpFilePath);

    const rewiredPatch = patchText
      .replace(`--- a/${targetFile}`, `--- a/${safeBasename}`)
      .replace(`+++ b/${targetFile}`, `+++ b/${safeBasename}`);
    fs.writeFileSync(tmpPatchPath, rewiredPatch);

    try {
      execSync(`git apply "${safeBasename}.patch"`, {
        cwd: tmpDir,
        stdio: "pipe",
      });
      patchContents.set(targetFile, fs.readFileSync(tmpFilePath, "utf8"));
    } catch (err) {
      results.set(targetFile, {
        valid: false,
        errors: ["Patch failed to apply cleanly.", (err as Error).message],
      });
    }
  }

  // Pass 2: build a single Project with all patched file contents.
  const tsconfigPath = path.join(workspacePath, "tsconfig.json");
  const project = new Project({
    tsConfigFilePath: fs.existsSync(tsconfigPath) ? tsconfigPath : undefined,
    skipAddingFilesFromTsConfig: true,
    compilerOptions: { allowJs: true, checkJs: true },
  });

  for (const [targetFile, content] of patchContents) {
    const fullTargetPath = path.resolve(workspacePath, targetFile);
    const existing = project.getSourceFile(fullTargetPath);
    if (existing) {
      existing.replaceWithText(content);
    } else {
      project.createSourceFile(fullTargetPath, content, { overwrite: true });
    }
  }

  // Pass 3: run diagnostics and group by file.
  const diagsByFile = new Map<string, string[]>();
  for (const diag of project.getPreEmitDiagnostics()) {
    const sf = diag.getSourceFile();
    if (!sf) continue;
    const filePath = sf.getFilePath() as string;
    const msg = diag.getMessageText();
    const code = diag.getCode();
    const messageStr = typeof msg === "string" ? msg : msg.getMessageText();

    // Suppress TS2307 for co-created siblings.
    if (code === 2307 && createTargets.size > 0) {
      const entry = patches.find(
        (p) => path.resolve(workspacePath, p.targetFile) === filePath,
      );
      const currentFile = entry?.targetFile ?? "";
      if (
        isImportErrorForCreateTarget(messageStr, currentFile, createTargets)
      ) {
        continue;
      }
    }

    const errors = diagsByFile.get(filePath) ?? [];
    errors.push(`TS${code}: ${messageStr}`);
    diagsByFile.set(filePath, errors);
  }

  // Build per-file results for files that applied successfully.
  for (const { targetFile } of patches) {
    if (results.has(targetFile)) continue;
    if (!patchContents.has(targetFile)) continue;
    const fullPath = path.resolve(workspacePath, targetFile);
    const errors = diagsByFile.get(fullPath) ?? [];
    results.set(targetFile, { valid: errors.length === 0, errors });
  }

  // Cleanup temp files.
  for (const f of tmpFiles) {
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }

  return results;
}

/**
 * Extract the file content from a create patch (`--- /dev/null`) by collecting
 * all `+` lines from the diff hunks. Avoids `git apply` entirely.
 */
function extractCreatePatchContent(patchText: string): string {
  const lines = patchText.split("\n");
  const content: string[] = [];
  let inHunk = false;

  for (const line of lines) {
    if (line.startsWith("@@")) {
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line === "\\ No newline at end of file") continue;
    if (line.startsWith("+") && !line.startsWith("+++")) {
      content.push(line.slice(1));
    }
  }

  // Join with real newlines; remove trailing newline added by the patch.
  let text = content.join("\n");
  if (text.endsWith("\n")) text = text.slice(0, -1);
  return text;
}

/**
 * Validate patched text in a fresh ts-morph Project.
 * Shared by the single-file and batch validators.
 */
function validateSourceText(
  patchedText: string,
  fullTargetPath: string,
  targetFile: string,
  workspacePath: string,
  options?: AstValidationOptions,
): TypeScriptAstValidationResult {
  const tsconfigPath = path.join(workspacePath, "tsconfig.json");
  const project = new Project({
    tsConfigFilePath: fs.existsSync(tsconfigPath) ? tsconfigPath : undefined,
    skipAddingFilesFromTsConfig: true,
    compilerOptions: { allowJs: true, checkJs: true },
  });

  const existing = project.getSourceFile(fullTargetPath);
  if (existing) {
    existing.replaceWithText(patchedText);
  } else {
    project.createSourceFile(fullTargetPath, patchedText);
  }

  const diagnostics = project.getPreEmitDiagnostics();
  const errors: string[] = [];
  const createTargets = options?.createTargets;

  for (const diag of diagnostics) {
    const msg = diag.getMessageText();
    const code = diag.getCode();
    const messageStr = typeof msg === "string" ? msg : msg.getMessageText();

    if (code === 2307 && createTargets && createTargets.size > 0) {
      if (isImportErrorForCreateTarget(messageStr, targetFile, createTargets)) {
        continue;
      }
    }

    errors.push(`TS${code}: ${messageStr}`);
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Check if a TS2307 error message refers to a module that is being created in the same batch.
 */
function isImportErrorForCreateTarget(
  message: string,
  currentFile: string,
  createTargets: Set<string>,
): boolean {
  // Extract module specifier from: "Cannot find module './foo' or its corresponding type declarations."
  const match = message.match(/Cannot find module '([^']+)'/);
  if (!match) return false;

  const specifier = match[1];
  // Resolve specifier relative to the current file's directory
  const currentDir = path.dirname(currentFile);
  const resolvedBase = path.join(currentDir, specifier).replace(/\\/g, "/");

  // Check with common extensions
  const extensions = ["", ".ts", ".js", ".tsx", ".jsx"];
  for (const ext of extensions) {
    const candidate = resolvedBase + ext;
    // Also check without .js → .ts (TS ESM convention)
    const tsVariant = candidate.replace(/\.js$/, ".ts");
    if (createTargets.has(candidate) || createTargets.has(tsVariant)) {
      return true;
    }
  }

  return false;
}
