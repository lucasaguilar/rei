import path from "path";

// Configuración de workspaces permitidos para el servidor
// Esto evita que cualquier directorio sea accedido por razones de seguridad
// Leemos de variables de entorno para no hardcodear rutas personales
function getAllowedWorkspaces(): Set<string> {
  if (process.env.ALLOWED_WORKSPACES) {
    const paths = process.env.ALLOWED_WORKSPACES.split(',').map(p => p.trim());
    return new Set(paths);
  }
  
  // Default fallback: allow the current working directory if nothing is set
  return new Set([process.cwd()]);
}

export const ALLOWED_WORKSPACES = getAllowedWorkspaces();

// Función para validar si un workspace es permitido (incluye subdirectorios recursivos)
export function isWorkspaceAllowed(workspacePath: string): boolean {
  const target = path.resolve(workspacePath);
  
  for (const allowed of ALLOWED_WORKSPACES) {
    const allowedResolved = path.resolve(allowed);
    const relative = path.relative(allowedResolved, target);
    
    // Si coincide exactamente o es un subdirectorio (no empieza con '..' ni es absoluto)
    if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
      return true;
    }
  }
  return false;
}

// Función para obtener el workspace por defecto
export function getDefaultWorkspace(): string {
  if (process.env.REI_WORKSPACE_PATH) {
    return process.env.REI_WORKSPACE_PATH;
  }
  return process.cwd();
}

