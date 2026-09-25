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

  it("agent is allowed everywhere INSIDE the workspace", () => {
    // This assertion used to read `/etc/passwd` → true: "unrestricted" was taken to mean
    // unrestricted on the filesystem, not within the workspace. See the containment block below.
    const agent = writeScopeForMode("agent");
    expect(isWriteAllowed("src/index.ts", WS, agent)).toBe(true);
    expect(isWriteAllowed("/etc/passwd", WS, agent)).toBe(false);
  });
});

/**
 * Containment applies to EVERY mode, agent included. `unrestricted` means "any file in this
 * project", never "any file on this machine": agent mode is the one that edits source, so it is
 * also the one that must not be talked into writing ~/.ssh/authorized_keys or a shell profile.
 *
 * The boundary is the same one `rm` and shell redirects already get in command-executor —
 * workspace + REI_ALLOWED_DIRS — so there is one answer to "where may REI write", not two.
 */
describe("workspace containment (all modes)", () => {
  const agent = writeScopeForMode("agent");
  const allowed = (p: string) => isWriteAllowed(p, WS, agent);

  it("blocks an absolute path outside the workspace", () => {
    expect(allowed("/etc/passwd")).toBe(false);
    expect(allowed("/Users/someone/.ssh/authorized_keys")).toBe(false);
  });

  it("blocks a '..' walk out of the workspace", () => {
    expect(allowed("../../../.zshrc")).toBe(false);
    expect(allowed("src/../../sibling-repo/x.ts")).toBe(false);
  });

  it("still allows everything inside, including dotfiles and new subtrees", () => {
    expect(allowed("src/index.ts")).toBe(true);
    expect(allowed(".env")).toBe(true); // agent's own project: its call, not ours
    expect(allowed(`${WS}/deep/new/dir/file.ts`)).toBe(true);
  });

  it("does not hand the agent REI's own install directory", () => {
    // ~/.rei holds the global .env (API keys) and the launcher scripts that run on next start.
    // `rm` may target it; writing there is a different risk and stays opt-in via REI_ALLOWED_DIRS.
    expect(allowed(`${process.env.HOME}/.rei/.env`)).toBe(false);
  });

  it("honours REI_ALLOWED_DIRS, the same escape hatch the command gate uses", () => {
    const prev = process.env.REI_ALLOWED_DIRS;
    process.env.REI_ALLOWED_DIRS = "/work/other-repo";
    try {
      expect(allowed("/work/other-repo/src/x.ts")).toBe(true);
      expect(allowed("/work/unlisted/src/x.ts")).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.REI_ALLOWED_DIRS;
      else process.env.REI_ALLOWED_DIRS = prev;
    }
  });

  it("refuses with a message that names the workspace, not the mode's directories", () => {
    expect(writeDeniedMessage("/etc/passwd", agent, WS)).toContain("outside the workspace");
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
