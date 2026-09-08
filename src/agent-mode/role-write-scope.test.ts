import { describe, it, expect } from "vitest";
import {
  writeScopeForMode,
  isWriteAllowed,
  writeDeniedMessage,
} from "./tools-loop/write-scope.js";

/**
 * A role declares the ONLY files it may write. The field was parsed and then ignored, so an auditor
 * that promised to stay out of your source could edit it — the base mode was the only thing keeping
 * it honest, and a role based on `agent` had nothing at all.
 */
const WS = "/tmp/ws";

describe("a role's writeGlob narrows the scope", () => {
  it("allows the files it names", () => {
    const scope = writeScopeForMode("planning", "*.review.md");
    expect(isWriteAllowed(".rei/plans/login.review.md", WS, scope)).toBe(true);
    expect(isWriteAllowed("login.review.md", WS, scope)).toBe(true);
  });

  it("refuses everything else, including what the MODE would allow", () => {
    // `planning` may write to .rei/plans — the role is stricter, and the stricter one wins.
    const scope = writeScopeForMode("planning", "*.review.md");
    expect(isWriteAllowed(".rei/plans/login.md", WS, scope)).toBe(false);
    expect(isWriteAllowed("src/auth.ts", WS, scope)).toBe(false);
  });

  it("restricts even a role based on agent — declaring a glob is the point", () => {
    const scope = writeScopeForMode("agent", "*.review.md");
    expect(scope.unrestricted).toBe(false);
    expect(isWriteAllowed("src/auth.ts", WS, scope)).toBe(false);
    expect(isWriteAllowed("notes.review.md", WS, scope)).toBe(true);
  });

  it("cannot be used to escape the workspace", () => {
    const scope = writeScopeForMode("planning", "*.md");
    expect(isWriteAllowed("../outside.md", WS, scope)).toBe(false);
    expect(isWriteAllowed("/etc/passwd.md", WS, scope)).toBe(false);
  });

  it("leaves the mode's own scope alone when no role is active", () => {
    const scope = writeScopeForMode("planning");
    expect(scope.glob).toBeUndefined();
    expect(isWriteAllowed(".rei/plans/login.md", WS, scope)).toBe(true);
    expect(isWriteAllowed("src/auth.ts", WS, scope)).toBe(false);
  });

  it("keeps agent unrestricted without a glob", () => {
    expect(isWriteAllowed("src/auth.ts", WS, writeScopeForMode("agent"))).toBe(true);
  });

  it("explains the refusal in terms of the role, not the mode", () => {
    // The model must be able to act on it: the mode is not what is blocking here.
    const msg = writeDeniedMessage("src/a.ts", writeScopeForMode("planning", "*.review.md"));
    expect(msg).toContain("*.review.md");
    expect(msg).toContain("/role off");
  });
});
