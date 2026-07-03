import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

/**
 * Resolve package.json relative to this file (not cwd) so it works both in dev
 * (`npm run dev`) and when installed globally (`rei --version`).
 */
function resolvePackageJson(): string {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  return path.join(__dirname, "..", "..", "package.json");
}

let cachedVersion: string | null = null;

export function getVersion(): string {
  if (cachedVersion !== null) return cachedVersion;
  const pkgPath = resolvePackageJson();
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
  cachedVersion = pkg.version ?? "0.0.0";
  return cachedVersion!;
}
