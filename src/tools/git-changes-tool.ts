import { detectGitChanges, type GitChange } from "../workspace/git-changes.js";

/**
 * Formats a list of detected git changes into a clean markdown table.
 */
export function formatGitChanges(changes: GitChange[]): string {
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
    return `| ${statusIcon(c.status)} ${statusLabel(c.status)} | \`${c.filePath}\` |`;
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
  return formatGitChanges(changes);
}
