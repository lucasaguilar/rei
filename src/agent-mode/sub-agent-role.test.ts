import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Role } from "../skills/role-loader.js";

// The param is typed so `mock.calls[0][0]` is inspectable — an untyped vi.fn infers an empty
// tuple and every assertion below becomes a type error.
const executeAgentTurnWithTools = vi.hoisted(() =>
  vi.fn(async (_params: Record<string, unknown>) => ({ response: "done" })),
);
vi.mock("./generator-tools.js", () => ({ executeAgentTurnWithTools }));
vi.mock("./project-profile.js", () => ({ buildProjectProfile: () => "" }));

import { runSubAgent } from "./sub-agent-runner.js";

const AUDITOR: Role = {
  name: "auditor",
  description: "adversarial review",
  baseMode: "planning",
  writeGlob: "*.review.md",
  preferredModel: "gemma-4-26b-a4b",
  body: "You are an adversarial auditor. You critique, you do NOT edit.",
};

const run = (role?: Role) =>
  runSubAgent({
    task: "audit the plan",
    role,
    provider: {} as never,
    workspacePath: process.cwd(),
    logger: { logInfo: () => {} } as never,
  });

const lastCall = (): Record<string, unknown> => executeAgentTurnWithTools.mock.calls[0][0];

beforeEach(() => executeAgentTurnWithTools.mockClear());

/**
 * A sub-agent runs the SAME native tool loop as agent mode. `mode: "agent"` was hardcoded and
 * `roleWriteGlob` was never passed, so a role invoked in isolation got write access to the whole
 * repository regardless of what its frontmatter declared — the failure this exists to prevent.
 */
describe("a sub-agent running a role adopts that role's permissions", () => {
  it("runs under the role's baseMode, not agent", async () => {
    await run(AUDITOR);
    expect(lastCall().mode).toBe("planning");
  });

  it("carries the role's writeGlob into the loop, where the write gate reads it", async () => {
    await run(AUDITOR);
    expect(lastCall().roleWriteGlob).toBe("*.review.md");
  });

  it("uses the role's preferred model, which is the point of a second opinion", async () => {
    await run(AUDITOR);
    expect(lastCall().modelOverride).toBe("gemma-4-26b-a4b");
  });

  it("makes the role's own posture the system prompt", async () => {
    await run(AUDITOR);
    const messages = lastCall().messagesForModel as Array<{ role: string; content: string }>;
    expect(messages[0].content).toContain("adversarial auditor");
  });

  it("does NOT give a read-only role the generic worker's edit-and-build instructions", async () => {
    // The default prompt tells the worker to make edits and run the build — the exact opposite of
    // what a read-only role instructs, and the two together are a contradiction it may resolve
    // either way.
    await run(AUDITOR);
    const messages = lastCall().messagesForModel as Array<{ content: string }>;
    expect(messages[0].content).not.toContain("make the edits");
  });

  it("still tells it that it is running blind, which its role body cannot know", async () => {
    await run(AUDITOR);
    const messages = lastCall().messagesForModel as Array<{ content: string }>;
    expect(messages[0].content).toContain("ISOLATED sub-agent");
  });

  it("stays depth-1 so a role cannot delegate further", async () => {
    await run(AUDITOR);
    expect(lastCall().depth).toBe(1);
  });
});

describe("without a role, the worker is unchanged", () => {
  it("keeps agent reach and the generic builder prompt", async () => {
    await run(undefined);
    expect(lastCall().mode).toBe("agent");
    expect(lastCall().roleWriteGlob).toBeUndefined();
    const messages = lastCall().messagesForModel as Array<{ content: string }>;
    expect(messages[0].content).toContain("focused sub-agent");
  });
});
