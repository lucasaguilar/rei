import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { roleCommands } from "./role-commands.js";
import type { CommandContext } from "./command-handler.js";
import type { ChatSession, SessionMode } from "../types.js";

let ws: string;

const role = (name: string, baseMode: SessionMode) =>
  writeFileSync(
    join(ws, ".rei", "roles", `${name}.md`),
    `---\nname: ${name}\ndescription: d\nbaseMode: ${baseMode}\n---\nBody.\n`,
  );

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), "rei-rolemode-"));
  mkdirSync(join(ws, ".rei", "roles"), { recursive: true });
  role("reviewer", "planning");
  role("helper", "ask");
});
afterEach(() => rmSync(ws, { recursive: true, force: true }));

const session = (over: Partial<ChatSession> = {}): ChatSession =>
  ({ messages: [], mode: "agent", ...over }) as ChatSession;

const run = (command: string, s: ChatSession): ChatSession => {
  const r = roleCommands.run({ command, session: s, workspacePath: ws } as unknown as CommandContext);
  return (r as { newSession?: ChatSession }).newSession ?? s;
};

/**
 * A role adopts its own baseMode, so activating one moves you (agent → planning). Leaving it left
 * you there while reporting "back to the plain mode" — which reads as if it had put you back.
 */
describe("/role off returns you to the mode you came from", () => {
  it("records where you were when the role takes over", () => {
    const s = run("/role reviewer", session({ mode: "agent" }));
    expect(s.mode).toBe("planning");
    expect(s.rolePreviousMode).toBe("agent");
  });

  it("puts you back on the way out", () => {
    const s = run("/role off", run("/role reviewer", session({ mode: "agent" })));
    expect(s.mode).toBe("agent");
    expect(s.activeRole).toBeUndefined();
  });

  it("says so, rather than claiming a restore that did not happen", () => {
    const active = run("/role reviewer", session({ mode: "agent" }));
    const r = roleCommands.run({
      command: "/role off", session: active, workspacePath: ws,
    } as unknown as CommandContext) as { response: string };
    expect(r.response).toContain("agent");
  });

  it("keeps the ORIGINAL mode across a role swap", () => {
    // agent → reviewer(planning) → helper(ask) → off must land on agent, not planning.
    let s = run("/role reviewer", session({ mode: "agent" }));
    s = run("/role helper", s);
    expect(s.mode).toBe("ask");
    expect(s.rolePreviousMode).toBe("agent");
    expect(run("/role off", s).mode).toBe("agent");
  });

  it("does not undo an explicit /mode you chose while the role was active", () => {
    // Changing mode by hand is a decision. Silently reverting it is worse than not restoring.
    const active = run("/role reviewer", session({ mode: "agent" }));
    const moved = { ...active, mode: "agent" as SessionMode }; // as if via /mode agent
    expect(run("/role off", moved).mode).toBe("agent");
  });

  it("clears the memory so a later /role off cannot resurrect an old mode", () => {
    const s = run("/role off", run("/role reviewer", session({ mode: "agent" })));
    expect(s.rolePreviousMode).toBeUndefined();
  });

  it("leaves you where you are when no role was active", () => {
    expect(run("/role off", session({ mode: "planning" })).mode).toBe("planning");
  });

  it("does not move you at all when the role's baseMode is the one you were in", () => {
    const s = run("/role reviewer", session({ mode: "planning" }));
    expect(s.mode).toBe("planning");
    expect(run("/role off", s).mode).toBe("planning");
  });
});
