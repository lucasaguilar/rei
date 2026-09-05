export const FULL_READ_MAX_CHARS = 100_000;

/** Files whose CONTENT is credentials, matched on basename so a nested copy counts too. */
export const SENSITIVE_FILE_NAMES = new Set([
  ".env",
  ".env.local",
  ".env.development",
  ".env.production",
  ".env.test",
  ".npmrc",
  ".yarnrc",
  ".yarnrc.yml",
  ".netrc",
  ".htpasswd",
]);

/** Extensions that are private keys or certificates. */
export const SENSITIVE_EXTENSIONS = new Set([
  ".pem",
  ".key",
  ".p12",
  ".pfx",
  ".crt",
  ".cer",
  ".der",
]);

/**
 * True when serving this path would hand the model credentials.
 *
 * Both sets sat here unused for months, so `read_files` served anything asked of it — its own
 * comment said so: "If the model asks for it, it gets it." A list that enforces nothing while
 * reading as a safeguard is worse than no list, because it stops anyone from adding a real one.
 *
 * Matched on the BASENAME: a workspace keeps its env at `.rei/.env`, and nesting is not a reason
 * to serve a secret.
 */
export function isSensitiveFile(filePath: string): boolean {
  const base = (filePath.split(/[\\/]/).pop() ?? "").toLowerCase();
  if (SENSITIVE_FILE_NAMES.has(base)) return true;
  // `.env.staging`, `.env.local.bak` — any suffix on an env file is still an env file.
  if (base.startsWith(".env.") || base === ".env") return true;
  const dot = base.lastIndexOf(".");
  return dot > 0 && SENSITIVE_EXTENSIONS.has(base.slice(dot));
}

/** Escape hatch for deliberately asking REI to look at a config file. */
export function sensitiveReadsAllowed(): boolean {
  return process.env.REI_ALLOW_SENSITIVE_READS === "true";
}
