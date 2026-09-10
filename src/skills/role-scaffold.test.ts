import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scaffoldRole, roleTemplate } from "./role-scaffold.js";
import { loadRole } from "./role-loader.js";

let ws: string;
const never = () => false;
const reserved = (n: string) => n === "trace";

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), "rei-scaffold-"));
});
afterEach(() => rmSync(ws, { recursive: true, force: true }));

describe("scaffoldRole", () => {
  it("creates the file where the loader looks for it", () => {
    const r = scaffoldRole("reviewer", ws, never);
    expect(r.ok).toBe(true);
    expect(r.file).toBe(".rei/roles/reviewer.md");
    expect(existsSync(join(ws, ".rei", "roles", "reviewer.md"))).toBe(true);
  });

  it("creates .rei/roles when the workspace has none yet", () => {
    expect(scaffoldRole("reviewer", ws, never).ok).toBe(true);
  });

  it("lowercases the name, since it is also the command", () => {
    scaffoldRole("Reviewer", ws, never);
    expect(existsSync(join(ws, ".rei", "roles", "reviewer.md"))).toBe(true);
  });
});

/**
 * The template is the parser's format written out. If they drift, the scaffold hands you a file
 * that looks right and loads as nothing — the worst kind of broken, because it fails silently at
 * the point where you have already written the whole posture.
 */
describe("what the scaffold writes, the loader reads", () => {
  it("round-trips through loadRole", () => {
    scaffoldRole("reviewer", ws, never);
    const role = loadRole("reviewer", ws);
    expect(role).not.toBeNull();
    expect(role!.name).toBe("reviewer");
  });

  it("carries the baseMode the template sets, not the parser's fallback", () => {
    scaffoldRole("reviewer", ws, never);
    expect(loadRole("reviewer", ws)!.baseMode).toBe("planning");
  });

  it("leaves the commented-out optional fields inert", () => {
    // They exist to be discovered and uncommented. The parser matches `^\s*<key>:`, so a leading
    // '#' must keep them from taking effect — otherwise every new role silently gets a writeGlob.
    scaffoldRole("reviewer", ws, never);
    const role = loadRole("reviewer", ws)!;
    expect(role.writeGlob).toBeUndefined();
    expect(role.preferredModel).toBeUndefined();
    expect(roleTemplate("reviewer")).toContain("# writeGlob:");
  });

  it("becomes a real role once a commented field is uncommented", () => {
    scaffoldRole("reviewer", ws, never);
    const f = join(ws, ".rei", "roles", "reviewer.md");
    writeFileSync(f, readFileSync(f, "utf-8").replace("# preferredModel:", "preferredModel:"));
    expect(loadRole("reviewer", ws)!.preferredModel).toBe("gemma-4-26b-a4b");
  });

  it("gives it a non-empty body, which the loader requires", () => {
    // parseRole returns null for a file with frontmatter and no body.
    scaffoldRole("reviewer", ws, never);
    expect(loadRole("reviewer", ws)!.body.length).toBeGreaterThan(50);
  });
});

describe("what it refuses", () => {
  it("refuses a name that is a built-in command, naming the reason", () => {
    const r = scaffoldRole("trace", ws, reserved);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("built-in");
  });

  it("refuses a name that is not usable as a filename or a command", () => {
    for (const bad of ["../escape", "has space", "9lives", "UPPER!", ""]) {
      expect(scaffoldRole(bad, ws, never).ok).toBe(false);
    }
  });

  it("never writes outside .rei/roles, whatever the name looks like", () => {
    scaffoldRole("../../pwned", ws, never);
    expect(existsSync(join(ws, "..", "..", "pwned.md"))).toBe(false);
  });

  it("refuses to overwrite an existing role", () => {
    scaffoldRole("reviewer", ws, never);
    writeFileSync(join(ws, ".rei", "roles", "reviewer.md"), "MY WORK");
    const r = scaffoldRole("reviewer", ws, never);
    expect(r.ok).toBe(false);
    expect(readFileSync(join(ws, ".rei", "roles", "reviewer.md"), "utf-8")).toBe("MY WORK");
  });

  it("does not clobber a file the loader cannot parse either", () => {
    // listRoles skips an unparsable file, so the existence check above would not see it. The `wx`
    // write flag is what actually stops the overwrite.
    mkdirSync(join(ws, ".rei", "roles"), { recursive: true });
    writeFileSync(join(ws, ".rei", "roles", "broken.md"), "");
    expect(scaffoldRole("broken", ws, never).ok).toBe(false);
    expect(readFileSync(join(ws, ".rei", "roles", "broken.md"), "utf-8")).toBe("");
  });
});
