// Configuración de workspaces permitidos para el servidor
// Esto evita que cualquier directorio sea accedido por razones de seguridad
export const ALLOWED_WORKSPACES = new Set([
  "/Users/lucasaguilar/www/lab/rei",
  "/Users/lucasaguilar/www/lab/app-for-news",
  "/Users/lucasaguilar/www/lab/new",
  // Agrega más rutas permitidas aquí
]);

// Función para validar si un workspace es permitido
export function isWorkspaceAllowed(workspacePath: string): boolean {
  return ALLOWED_WORKSPACES.has(workspacePath);
}

// Función para obtener el workspace por defecto
export function getDefaultWorkspace(): string {
  return "/Users/lucasaguilar/www/lab/rei";
}
