import path from "path";

// Which workspaces the server may open.
//
// The server runs an agent that edits files and executes commands, so the set of directories it
// can be pointed at is a security boundary, not a convenience. It comes from the environment
// rather than the source: a hardcoded path would be both wrong for everyone else and impossible
// to narrow per machine.
function getAllowedWorkspaces(): Set<string> {
  if (process.env.ALLOWED_WORKSPACES) {
    const paths = process.env.ALLOWED_WORKSPACES.split(',').map(p => p.trim());
    return new Set(paths);
  }
  
  // Default fallback: allow the current working directory if nothing is set
  return new Set([process.cwd()]);
}

export const ALLOWED_WORKSPACES = getAllowedWorkspaces();

// Whether a path is inside an allowed workspace (subdirectories included).
export function isWorkspaceAllowed(workspacePath: string): boolean {
  const target = path.resolve(workspacePath);
  
  for (const allowed of ALLOWED_WORKSPACES) {
    const allowedResolved = path.resolve(allowed);
    const relative = path.relative(allowedResolved, target);
    
    // An exact match, or a subdirectory: `relative` is then neither absolute nor starts with '..'
    if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
      return true;
    }
  }
  return false;
}

// The workspace to use when none was given.
export function getDefaultWorkspace(): string {
  if (process.env.REI_WORKSPACE_PATH) {
    return process.env.REI_WORKSPACE_PATH;
  }
  return process.cwd();
}

