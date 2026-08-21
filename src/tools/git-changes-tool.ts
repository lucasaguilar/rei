import * as path from "node:path";
import { detectGitChanges, type GitChange } from "../workspace/git-changes.js";

/**
 * Formats a list of detected git changes into a clean markdown table.
 *
 * File paths are emitted as markdown links to the ABSOLUTE path (`[`rel`](/abs/rel)`), not bare
 * inline code. Two reasons: (1) a link is clickable in the IDE (VS Code / Cursor / Cline) whereas a
 * code span is not; (2) git returns workspace-RELATIVE paths, which the IDE can't resolve from a chat
 * message — the absolute href fixes that, and survives even when the cell truncates the visible label.
 */
export function formatGitChanges(
  changes: GitChange[],
  workspacePath?: string,
): string {
  if (changes.length === 0) {
    return "No se detectaron cambios en el repositorio.";
  }

  const statusIcon = (status: GitChange["status"]): string => {
    switch (status) {
      case "added": return "🟢";
      case "modified": return "✏️";
      case "deleted": return "🗑️";
      case "renamed": return "↔️";
    }
  };

  const statusLabel = (status: GitChange["status"]): string => {
    switch (status) {
      case "added": return "Añadido";
      case "modified": return "Modificado";
      case "deleted": return "Eliminado";
      case "renamed": return "Renombrado";
    }
  };

  const header = [
    `| ${statusIcon("modified")} Estado | Archivo |`,
    `| --- | --- |`,
  ];

  const rows = changes.map((c) => {
    const href = workspacePath
      ? path.resolve(workspacePath, c.filePath)
      : c.filePath;
    // Link label = relative path (readable, may truncate); link target = absolute (always resolves).
    const fileCell = `[\`${c.filePath}\`](${href})`;
    return `| ${statusIcon(c.status)} ${statusLabel(c.status)} | ${fileCell} |`;
  });

  return [header.join("\n"), ...rows].join("\n");
}

/**
 * Returns a summary of git changes grouped by status.
 */
export function summarizeGitChanges(changes: GitChange[]): string {
  const added = changes.filter((c) => c.status === "added").length;
  const modified = changes.filter((c) => c.status === "modified").length;
  const deleted = changes.filter((c) => c.status === "deleted").length;
  const renamed = changes.filter((c) => c.status === "renamed").length;

  const parts: string[] = [];
  if (added > 0) parts.push(`🟢 ${added} añadido(s)`);
  if (modified > 0) parts.push(`✏️ ${modified} modificado(s)`);
  if (deleted > 0) parts.push(`🗑️ ${deleted} eliminado(s)`);
  if (renamed > 0) parts.push(`↔️ ${renamed} renombrado(s)`);

  return `**${changes.length} cambio(s) en total:** ${parts.join(", ")}`;
}

/**
 * Detecta los cambios del repositorio Git y los formatea para inyectar al modelo.
 */
export async function getGitChanges(workspacePath: string): Promise<string> {
  const changes = await detectGitChanges(workspacePath);
  return formatGitChanges(changes, workspacePath);
}
