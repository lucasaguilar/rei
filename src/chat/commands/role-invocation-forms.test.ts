import { describe, it, expect } from "vitest";
import { roleCommands } from "./role-commands.js";
import { roleAgentCommands } from "./role-agent-commands.js";
import type { CommandContext } from "./command-handler.js";

const ws = process.cwd(); // the repo's own prompts/roles/auditor.md
const ctx = (command: string) =>
  ({ command, workspacePath: ws, session: { messages: [], mode: "agent" } }) as unknown as CommandContext;

/**
 * The two invocations of a role are not the same command with an extra argument — they differ in
 * whose context the role runs in. `/role <name> <task>` is the shape everyone tries first, and it
 * belongs to neither: unclaimed it produced "Unknown command", which is accurate and useless.
 */
describe("the two forms are distinct commands", () => {
  it("/role <name> activates the posture in this session", () => {
    expect(roleCommands.match("/role auditor")).toBe(true);
    expect(roleAgentCommands.match("/role auditor", ctx("/role auditor"))).toBe(false);
  });

  it("/<name> <task> runs it isolated — the role name IS the command", () => {
    const c = "/auditor audit @plan.md";
    expect(roleAgentCommands.match(c, ctx(c))).toBe(true);
    expect(roleCommands.match(c)).toBe(false);
  });
});

describe("/role <name> <task> — the shape that does not exist", () => {
  const run = (c: string) => roleCommands.run(ctx(c)) as { success: boolean; response: string };

  it("is claimed rather than reported as an unknown command", () => {
    expect(roleCommands.match("/role auditor audit @plan.md")).toBe(true);
  });

  it("shows BOTH forms spelled out with the user's own task", () => {
    const r = run("/role auditor audit @plan.md");
    expect(r.success).toBe(false);
    expect(r.response).toContain("/role auditor");
    expect(r.response).toContain("/auditor audit @plan.md");
  });

  it("explains the difference that decides between them: whose context it runs in", () => {
    const r = run("/role auditor audit @plan.md");
    expect(r.response).toContain("THIS session");
    expect(r.response).toContain("CLEAN context");
  });

  it("also says when the role does not exist at all", () => {
    expect(run("/role nosuchrole do a thing").response).toContain("no role called");
  });

  it("does not fire the role, since it cannot tell which was meant", () => {
    expect(run("/role auditor audit @plan.md").success).toBe(false);
  });

  it("leaves the plain /role <name> untouched", () => {
    expect(run("/role auditor").success).toBe(true);
  });
});
