import { describe, it, expect, afterEach } from "vitest";
import { STATIC_ALLOWED_COMMANDS, getAllowedCommands, DENIED_KEYWORDS } from "./sandbox-config.js";

/**
 * The allow-list is not a sandbox — a heredoc to `python3` is arbitrary code, by design, and REI's own
 * error messages recommend it (see docs/security-layer-phase-1.md). What it can still do is not hand
 * out the COMFORTABLE escape routes, and not carry an entry nothing needs.
 */
afterEach(() => {
  delete process.env.REI_ALLOWED_COMMANDS;
});

describe("the default allow-list", () => {
  it("does not offer osascript", () => {
    // `osascript -e 'do shell script "…"'` runs arbitrary shell behind a permitted first word, and
    // AppleScript reaches Mail, Messages and Notes besides. It is the only entry that is not a build
    // tool, nothing in REI needs it through run_command (clipboard-image.ts calls the binary
    // directly, not through the allow-list), and it arrived by inheritance rather than by decision.
    expect(STATIC_ALLOWED_COMMANDS.has("osascript")).toBe(false);
  });

  it("does not offer env, whose whole output is the process environment", () => {
    expect(STATIC_ALLOWED_COMMANDS.has("env")).toBe(false);
  });

  it("still offers the tools a build actually needs", () => {
    for (const cmd of ["npm", "node", "git", "python3", "cargo", "go", "ls", "grep", "rg"]) {
      expect(STATIC_ALLOWED_COMMANDS.has(cmd), cmd).toBe(true);
    }
  });

  it("gives back what was removed to anyone who asks for it by name", () => {
    process.env.REI_ALLOWED_COMMANDS = "osascript,env";
    expect(getAllowedCommands()).toContain("osascript");
    expect(getAllowedCommands()).toContain("env");
  });

  it("keeps the hard denials unreachable through that door", () => {
    // DENIED_KEYWORDS is checked before the allow-list, so adding these grants nothing.
    expect(DENIED_KEYWORDS).toContain("sudo");
    expect(DENIED_KEYWORDS).toContain("rm -rf");
  });
});
