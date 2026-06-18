import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Spec persistence — the upstream half of REI's spec-driven flow. A spec is the
 * artifact produced by the `write-spec` planning skill (Goal / In scope / Out of
 * scope / Acceptance criteria). It is saved to `.rei/specs/<name>.md`, mirroring
 * how plans live in `.rei/plans/`. Persisting it lets a spec survive `/session`
 * and be reloaded into a fresh planning turn so `micro-task-decomposition`
 * consumes it (and the plan can't drift past the spec's scope).
 */

// Detects a spec message: the `# Spec:` heading the write-spec skill emits, or a
// message carrying the acceptance-criteria section (the spec's defining part).
const SPEC_HEADING = /^#\s+spec\s*:/im;
const SPEC_ACCEPTANCE = /^##\s+acceptance\s+criteria\b/im;

export function isSpecMessage(content: string): boolean {
  return SPEC_HEADING.test(content) || SPEC_ACCEPTANCE.test(content);
}

/** Saves the full spec content to `.rei/specs/<name>.md` in the workspace. */
export function saveSpecToFile(
  workspacePath: string,
  specName: string,
  specContent: string,
): string {
  // Sanitize the name to prevent path traversal.
  const sanitized = specName.replace(/[^a-zA-Z0-9_\-]/g, "_");
  const specsDir = path.join(workspacePath, ".rei", "specs");
  const filePath = path.join(specsDir, `${sanitized}.md`);

  try {
    fs.mkdirSync(specsDir, { recursive: true });
    fs.writeFileSync(filePath, specContent, "utf8");
    return filePath;
  } catch (err) {
    throw new Error(
      `Failed to save spec to disk: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Loads spec content from `.rei/specs/<name>.md` (or a direct path) in the workspace. */
export function loadSpecFromFile(
  workspacePath: string,
  specName: string,
): string {
  const sanitized = specName.replace(/[^a-zA-Z0-9_\-]/g, "_");

  let filePath = path.join(workspacePath, ".rei", "specs", `${sanitized}.md`);
  if (!fs.existsSync(filePath)) {
    // Fall back to a path/filename given directly relative to the workspace.
    filePath = path.resolve(workspacePath, specName);
    if (!fs.existsSync(filePath)) {
      throw new Error(`Spec file not found: '${specName}'`);
    }
  }

  try {
    return fs.readFileSync(filePath, "utf8");
  } catch (err) {
    throw new Error(
      `Failed to read spec from disk: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
