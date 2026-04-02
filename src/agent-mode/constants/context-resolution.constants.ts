export const FULL_READ_MAX_CHARS = 100_000;

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

export const SENSITIVE_EXTENSIONS = new Set([
  ".pem",
  ".key",
  ".p12",
  ".pfx",
  ".crt",
  ".cer",
  ".der",
]);
