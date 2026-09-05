import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  isSensitiveFile,
  sensitiveReadsAllowed,
} from "./constants/context-resolution.constants.js";

/**
 * `SENSITIVE_FILE_NAMES` and `SENSITIVE_EXTENSIONS` were declared and then never imported, so
 * `read_files` served whatever it was asked for — its own comment said as much: "If the model asks
 * for it, it gets it." These cover the predicate that finally connects them.
 */
describe("isSensitiveFile", () => {
  it("refuses env files wherever they sit", () => {
    expect(isSensitiveFile(".env")).toBe(true);
    // The canonical per-workspace location is nested; nesting is not a reason to serve a secret.
    expect(isSensitiveFile(".rei/.env")).toBe(true);
    expect(isSensitiveFile("/abs/path/to/project/.rei/.env")).toBe(true);
  });

  it("covers env variants, including ones no list enumerates", () => {
    expect(isSensitiveFile(".env.local")).toBe(true);
    expect(isSensitiveFile(".env.production")).toBe(true);
    expect(isSensitiveFile(".env.staging")).toBe(true); // not in the set — caught by the prefix rule
    expect(isSensitiveFile("config/.env.local.bak")).toBe(true);
  });

  it("refuses private keys and certificates by extension", () => {
    for (const f of ["id_rsa.pem", "server.key", "cert.crt", "bundle.p12", "a/b/client.pfx"]) {
      expect(isSensitiveFile(f)).toBe(true);
    }
  });

  it("refuses the other credential files on the list", () => {
    expect(isSensitiveFile(".npmrc")).toBe(true);
    expect(isSensitiveFile(".netrc")).toBe(true);
    expect(isSensitiveFile(".htpasswd")).toBe(true);
  });

  it("ignores case, since the check is on a filename", () => {
    expect(isSensitiveFile("SERVER.KEY")).toBe(true);
    expect(isSensitiveFile(".ENV")).toBe(true);
  });

  it("serves ordinary source and config files", () => {
    // The guard must not become a reason to withhold the repo itself.
    for (const f of [
      "src/index.ts",
      "package.json",
      "rei.config.json",
      "README.md",
      "environment.ts", // contains "env" but is a normal source file
      ".rei/rules.md",
      "docs/keys.md", // "keys" in the name, not a key file
    ]) {
      expect(isSensitiveFile(f)).toBe(false);
    }
  });
});

describe("sensitiveReadsAllowed", () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.REI_ALLOW_SENSITIVE_READS;
    delete process.env.REI_ALLOW_SENSITIVE_READS;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.REI_ALLOW_SENSITIVE_READS;
    else process.env.REI_ALLOW_SENSITIVE_READS = saved;
  });

  it("is off unless explicitly turned on", () => {
    expect(sensitiveReadsAllowed()).toBe(false);
    process.env.REI_ALLOW_SENSITIVE_READS = "false";
    expect(sensitiveReadsAllowed()).toBe(false);
    process.env.REI_ALLOW_SENSITIVE_READS = "1"; // only the exact opt-in counts
    expect(sensitiveReadsAllowed()).toBe(false);
  });

  it("opens the hatch on the exact value", () => {
    process.env.REI_ALLOW_SENSITIVE_READS = "true";
    expect(sensitiveReadsAllowed()).toBe(true);
  });
});
