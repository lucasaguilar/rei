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

// Función para validar si un workspace es permitido
export function isWorkspaceAllowed(workspacePath: string): boolean {
  return ALLOWED_WORKSPACES.has(workspacePath);
}

// Función para obtener el workspace por defecto
export function getDefaultWorkspace(): string {
  if (process.env.REI_WORKSPACE_PATH) {
    return process.env.REI_WORKSPACE_PATH;
  }
  return process.cwd();
}
