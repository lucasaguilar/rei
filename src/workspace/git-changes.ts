import * as fs from "fs";
import * as path from "path";
import { exec } from "child_process";
import { promisify } from "util";
import { scanWorkspace } from "./workspace-scanner.js";

const execAsync = promisify(exec);

export interface GitChange {
  filePath: string;
  status: "added" | "modified" | "deleted" | "renamed";
}

/**
 * Detects changes in the Git repository since the last commit.
 */
export async function detectGitChanges(workspacePath: string): Promise<GitChange[]> {
  try {
    const { stdout } = await execAsync("git diff --name-status HEAD", {
      cwd: workspacePath,
      maxBuffer: 1024 * 1024 * 6,
    });

    const changes: GitChange[] = [];
    const lines = stdout.trim().split("\n");

    for (const line of lines) {
      if (!line.trim()) continue;
      
      const [status, filePath] = line.split(/\s+/, 2);
      if (!filePath) continue;

      let changeStatus: GitChange["status"] = "modified";
      switch (status.charAt(0)) {
        case "A": changeStatus = "added"; break;
        case "M": changeStatus = "modified"; break;
        case "D": changeStatus = "deleted"; break;
        case "R": changeStatus = "renamed"; break;
      }

      // Solo incluir archivos relevantes (no en node_modules, etc.)
      if (!filePath.includes("node_modules") && !filePath.includes(".git")) {
        changes.push({
          filePath: filePath.trim(),
          status: changeStatus
        });
      }
    }

    return changes;
  } catch (error) {
    // Si no hay acceso a git o no está en un repositorio, retornar vacío
    return [];
  }
}

/**
 * Returns the repository's current state (modified files).
 */
export async function getGitStatus(workspacePath: string): Promise<string[]> {
  try {
    const { stdout } = await execAsync("git status --porcelain", {
      cwd: workspacePath,
      maxBuffer: 1024 * 1024 * 6,
    });

    const files: string[] = [];
    const lines = stdout.trim().split("\n");

    for (const line of lines) {
      if (!line.trim()) continue;
      
      const filePath = line.substring(3).trim();
      if (filePath && !filePath.includes("node_modules") && !filePath.includes(".git")) {
        files.push(filePath);
      }
    }

    return files;
  } catch (error) {
    return [];
  }
}

/**
 * Rebuilds the repository index with the detected changes.
 */
export async function regenerateRepoIndex(workspacePath: string): Promise<void> {
  try {
    // 1. Escaneamos el workspace para obtener archivos actuales
    const files = scanWorkspace(workspacePath);
    
    // 2. Si hay cambios detectados, actualizamos el índice RAG
    const changes = await detectGitChanges(workspacePath);
    if (changes.length > 0) {
      // Aquí se podría implementar una actualización parcial del índice RAG
      // Por ahora solo lo notificamos
      console.log(`[GIT] Detected ${changes.length} changes, regenerating index...`);
    }
    
    // 3. Actualizamos el mapa del repositorio (si se implementa)
    // Esto podría ser una llamada a una función de actualización del índice RAG
    
  } catch (error) {
    console.warn("[GIT] Failed to regenerate repo index:", error);
  }
}