import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  roleAgentCommands,
  resolveInvokableRole,
  RESERVED_COMMAND_NAMES,
} from "./role-agent-commands.js";
import type { CommandContext } from "./command-handler.js";
import { dispatchCommand } from "./registry.js";

// Typed param: an untyped vi.fn infers an empty tuple, so mock.calls[0][0] would not typecheck.
const runSubAgent = vi.hoisted(() =>
  vi.fn(async (_params: { role: { name: string; baseMode: string; writeGlob?: string } }) => "the report"),
);
vi.mock("../../agent-mode/sub-agent-runner.js", () => ({ runSubAgent }));
vi.mock("../../core/logger.js", () => ({ AgentLogger: class {} }));

let ws: string;

const REVIEWER = `---
name: reviewer
description: Reviews a plan
baseMode: planning
writeGlob: "*.review.md"
preferredModel: gemma-4-26b-a4b
---
You review plans. Do not edit code.
`;

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), "rei-roleagent-"));
  mkdirSync(join(ws, ".rei", "roles"), { recursive: true });
  writeFileSync(join(ws, ".rei", "roles", "reviewer.md"), REVIEWER);
  runSubAgent.mockClear();
});
afterEach(() => rmSync(ws, { recursive: true, force: true }));

const ctx = (command: string): CommandContext =>
  ({
    command,
    workspacePath: ws,
    session: { messages: [], mode: "agent" },
    provider: {},
  }) as unknown as CommandContext;

describe("resolveInvokableRole", () => {
  it("matches a role that exists on disk", () => {
    expect(resolveInvokableRole("/reviewer audit x", ws)?.role.name).toBe("reviewer");
  });

  it("splits the role from its task", () => {
    expect(resolveInvokableRole("/reviewer audit @plan.md", ws)?.task).toBe("audit @plan.md");
  });

  it("does not match a name with no role behind it", () => {
    expect(resolveInvokableRole("/nosuchthing do x", ws)).toBeNull();
  });

  it("refuses a name that is a built-in command, even with a role file of that name", () => {
    writeFileSync(join(ws, ".rei", "roles", "trace.md"), REVIEWER.replace("reviewer", "trace"));
    expect(RESERVED_COMMAND_NAMES.has("trace")).toBe(true);
    expect(resolveInvokableRole("/trace", ws)).toBeNull();
  });

  it("claims nothing without a workspace, so unknown commands still report as unknown", () => {
    // It matches on DATA. With no workspace to read there is no command set, and claiming the
    // input anyway would swallow every typo into this handler.
    expect(resolveInvokableRole("/reviewer x", undefined)).toBeNull();
    expect(roleAgentCommands.match("/reviewer x")).toBe(false);
  });
});

/**
 * The reason step 1 came before the command: a sub-agent runs the same native tool loop as agent
 * mode. Invoking a read-only role that way WITHOUT passing its profile through would hand an
 * adversarial reviewer write access to the whole repository — the opposite of what its own
 * frontmatter declares.
 */
describe("an isolated role keeps its own permissions", () => {
  it("passes the role through to the worker rather than a bare task", async () => {
    await roleAgentCommands.run(ctx("/reviewer audit @plan.md"));
    expect(runSubAgent).toHaveBeenCalledTimes(1);
    expect(runSubAgent.mock.calls[0][0].role.name).toBe("reviewer");
  });

  it("carries the role's baseMode and writeGlob, not agent's reach", async () => {
    await roleAgentCommands.run(ctx("/reviewer audit @plan.md"));
    const { role } = runSubAgent.mock.calls[0][0];
    expect(role.baseMode).toBe("planning");
    expect(role.writeGlob).toBe("*.review.md");
  });

  it("says in its answer what the role was allowed to write", async () => {
    const r = await roleAgentCommands.run(ctx("/reviewer audit @plan.md"));
    expect(r.response).toContain("*.review.md");
    expect(r.response).toContain("the report");
  });
});

describe("the isolated invocation needs a target", () => {
  it("refuses a bare /role-name and explains why", async () => {
    // The worker cannot see this conversation, so "audit it" resolves to nothing there.
    const r = await roleAgentCommands.run(ctx("/reviewer"));
    expect(r.success).toBe(false);
    expect(runSubAgent).not.toHaveBeenCalled();
    expect(r.response).toContain("isolated context");
  });

  it("points at /role for the shared-context form instead", async () => {
    expect((await roleAgentCommands.run(ctx("/reviewer"))).response).toContain("/role reviewer");
  });

  it("refuses without a provider rather than throwing", async () => {
    const bare = { ...ctx("/reviewer audit x"), provider: undefined } as unknown as CommandContext;
    expect((await roleAgentCommands.run(bare)).success).toBe(false);
  });
});

describe("dispatch order", () => {
  it("lets a static command win its name, since the dynamic handler runs last", async () => {
    writeFileSync(join(ws, ".rei", "roles", "compact.md"), REVIEWER.replace("reviewer", "compact"));
    const result = await dispatchCommand(ctx("/compact"));
    // Whatever /compact does, it is NOT the sub-agent.
    expect(runSubAgent).not.toHaveBeenCalled();
    expect(result).not.toBeNull();
  });

  it("routes an unreserved role name to the sub-agent", async () => {
    await dispatchCommand(ctx("/reviewer audit @plan.md"));
    expect(runSubAgent).toHaveBeenCalledTimes(1);
  });
});
