import type { AgentSREdit } from "../../contracts/agent-interaction.types.js";
import type { FileMeta } from "../../workspace/workspace-scanner.js";
import { findSymbolCallers, rankCallerFiles } from "../../context/caller-graph.js";

const MAX_AUTO_INJECTED_CALLER_FILES = 5;

/**
 * Extracts public method or function signatures from a code block.
 */
export function extractPublicContractSignatures(block: string): Map<string, string> {
  const signatures = new Map<string, string>();
  const lines = block.split("\n");

  for (const line of lines) {
    const normalized = line.trim();
    if (!normalized) continue;

    const publicMethod = normalized.match(
      /^public\s+(?:static\s+)?(?:async\s+)?([A-Za-z_$][A-Za-z0-9_$]*)\s*\([^)]*\)/,
    );
    if (publicMethod) {
      signatures.set(publicMethod[1], normalized.replace(/\s+/g, " "));
      continue;
    }

    const exportedFunction = normalized.match(
      /^export\s+(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\([^)]*\)/,
    );
    if (exportedFunction) {
      signatures.set(exportedFunction[1], normalized.replace(/\s+/g, " "));
    }
  }

  return signatures;
}

/**
 * Detects whether any proposed edits modify public method/function contracts.
 */
export function detectContractChangeSymbols(edits: AgentSREdit[]): string[] {
  const changedSymbols = new Set<string>();

  for (const edit of edits) {
    const before = extractPublicContractSignatures(edit.search);
    const after = extractPublicContractSignatures(edit.replace);

    for (const [symbol, beforeSig] of before) {
      const afterSig = after.get(symbol);
      if (!afterSig || afterSig !== beforeSig) {
        changedSymbols.add(symbol);
      }
    }

    for (const symbol of after.keys()) {
      if (!before.has(symbol)) {
        changedSymbols.add(symbol);
      }
    }
  }

  return [...changedSymbols];
}

/**
 * Identifies additional workspace files referencing changed method symbols that should be auto-injected.
 */
export function findAdditionalCallerFiles(params: {
  workspacePath: string;
  scannedFiles: FileMeta[];
  edits: AgentSREdit[];
  alreadyInjectedFiles: Set<string>;
}): { callerFiles: string[]; changedSymbols: string[] } {
  const { workspacePath, scannedFiles, edits, alreadyInjectedFiles } = params;
  const changedSymbols = detectContractChangeSymbols(edits);
  if (changedSymbols.length === 0) {
    return { callerFiles: [], changedSymbols };
  }

  const editedFiles = new Set(edits.map((edit) => edit.file));
  const refs = findSymbolCallers({
    workspacePath,
    symbolNames: changedSymbols,
    scannedFiles,
    maxResults: 40,
  });

  const callerFiles = rankCallerFiles(refs)
    .filter(
      (filePath) =>
        !editedFiles.has(filePath) && !alreadyInjectedFiles.has(filePath),
    )
    .slice(0, MAX_AUTO_INJECTED_CALLER_FILES);

  return { callerFiles, changedSymbols };
}
