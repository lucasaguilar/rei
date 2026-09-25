import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { readFileSync as read } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureReiDirIgnored, REI_DIR_GITIGNORE } from "./rei-dir.js";
import { AgentLogger } from "../core/logger.js";

/**
 * `<ws>/.rei` holds API keys and a transcript of the session inside the user's own repository. The
 * only thing standing between that and a `git add -A` is this nested ignore file.
 */
let ws: string;
beforeEach(() => { ws = mkdtempSync(join(tmpdir(), "rei-dir-")); });
afterEach(() => { rmSync(ws, { recursive: true, force: true }); });

const ignorePath = () => join(ws, ".rei", ".gitignore");

describe("ensureReiDirIgnored", () => {
  it("ignores everything in the directory", () => {
    mkdirSync(join(ws, ".rei"), { recursive: true });
    ensureReiDirIgnored(ws);
    expect(readFileSync(ignorePath(), "utf8")).toMatch(/^\*$/m);
  });

  it("does nothing when .rei does not exist — no empty directory left behind", () => {
    ensureReiDirIgnored(ws);
    expect(existsSync(join(ws, ".rei"))).toBe(false);
  });

  it("never overwrites an existing one", () => {
    mkdirSync(join(ws, ".rei"), { recursive: true });
    writeFileSync(ignorePath(), "!rules.md\n");
    ensureReiDirIgnored(ws);
    expect(readFileSync(ignorePath(), "utf8")).toBe("!rules.md\n");
  });
});

describe("the logger, which creates .rei/logs on a hand-configured install", () => {
  it("leaves the directory ignored", () => {
    new AgentLogger(ws);
    expect(existsSync(join(ws, ".rei", "logs"))).toBe(true);
    expect(readFileSync(ignorePath(), "utf8")).toMatch(/^\*$/m);
  });
});

describe("the wizard's standalone copy", () => {
  it("writes the same contents — it cannot import this module, so the rule is duplicated", () => {
    const src = read(fileURLToPath(new URL("../../scripts/launch-rei.js", import.meta.url)), "utf8");
    // The JS source escapes the newline; compare against that spelling.
    const asWritten = REI_DIR_GITIGNORE.replace(/\n/g, "\\n");
    expect(src).toContain(asWritten);
  });
});
