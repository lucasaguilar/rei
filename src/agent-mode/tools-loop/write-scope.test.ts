import { describe, it, expect } from "vitest";
import { writeScopeForMode, isWriteAllowed, writeDeniedMessage } from "./write-scope.js";
import { toolsForMode } from "../../contracts/tool-definitions.js";

/**
 * `planning` can write the spec-driven flow's artifacts and nothing else. The value of the mode is
 * that it CANNOT touch source, so the escape routes matter more than the happy path: a `..` walk, an
 * absolute path, or a sibling directory whose name merely starts with an allowed one.
 */
const WS = "/work/repo";

describe("writeScopeForMode", () => {
  it("leaves agent unrestricted", () => {
    expect(writeScopeForMode("agent").unrestricted).toBe(true);
  });
  it("restricts planning and ask", () => {
    for (const mode of ["planning", "ask"]) {
      expect(writeScopeForMode(mode).unrestricted, mode).toBe(false);
    }
  });
  it("treats an unknown/absent mode as agent — the loop's default, not a silent lockout", () => {
    expect(writeScopeForMode(undefined).unrestricted).toBe(true);
  });
});

describe("isWriteAllowed under planning", () => {
  const scope = writeScopeForMode("planning");
  const allowed = (p: string) => isWriteAllowed(p, WS, scope);

  it("allows the flow's artifacts", () => {
    expect(allowed(".rei/specs/feature.md")).toBe(true);
    expect(allowed(".rei/plans/feature.md")).toBe(true);
    expect(allowed("docs/design.md")).toBe(true);
    expect(allowed("docs/adr/0001-choice.md")).toBe(true);
  });

  it("blocks source", () => {
    expect(allowed("src/index.ts")).toBe(false);
    expect(allowed("package.json")).toBe(false);
    expect(allowed(".env")).toBe(false);
  });

  it("blocks a '..' walk out of an allowed directory", () => {
    expect(allowed("docs/../src/index.ts")).toBe(false);
    expect(allowed(".rei/specs/../../src/index.ts")).toBe(false);
    expect(allowed("docs/../../outside.md")).toBe(false);
  });

  it("blocks an absolute path that lands outside", () => {
    expect(allowed("/etc/passwd")).toBe(false);
    expect(allowed(`${WS}/src/index.ts`)).toBe(false);
  });

  it("allows an absolute path that lands inside", () => {
    expect(allowed(`${WS}/docs/design.md`)).toBe(true);
  });

  it("does not let a sibling directory pass on a name prefix", () => {
    expect(allowed("docs-private/secret.md")).toBe(false);
    expect(allowed(".rei/specsational/x.md")).toBe(false);
  });

  it("agent is allowed everywhere", () => {
    const agent = writeScopeForMode("agent");
    expect(isWriteAllowed("src/index.ts", WS, agent)).toBe(true);
    expect(isWriteAllowed("/etc/passwd", WS, agent)).toBe(true);
  });
});

describe("the refusal", () => {
  it("names the writable directories and the way forward", () => {
    const msg = writeDeniedMessage("src/index.ts", writeScopeForMode("planning"));
    expect(msg).toContain(".rei/specs");
    expect(msg).toContain("docs");
    expect(msg).toContain("/mode agent");
  });
});

describe("toolsForMode", () => {
  const names = (m: "agent" | "planning" | "ask") => toolsForMode(m).map((t) => t.function.name);

  it("offers create/edit in planning so the model can persist artifacts", () => {
    expect(names("planning")).toEqual(expect.arrayContaining(["create_file", "edit_file"]));
  });
  it("does NOT offer rewrite_file in planning — whole-file overwrite is an agent capability", () => {
    expect(names("planning")).not.toContain("rewrite_file");
  });
  it("keeps ask read-only", () => {
    expect(names("ask")).not.toContain("create_file");
    expect(names("ask")).not.toContain("edit_file");
  });
  it("leaves agent with the full set", () => {
    expect(names("agent")).toEqual(expect.arrayContaining(["create_file", "edit_file", "rewrite_file"]));
  });
});
