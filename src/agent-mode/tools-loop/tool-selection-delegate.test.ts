import { describe, it, expect, vi, beforeEach } from "vitest";
import { setupToolSelection } from "./tool-selection.js";

const fakeLogger = new Proxy({}, { get: () => vi.fn() }) as never;

function toolNames(allowSubAgents: boolean): string[] {
  const sel = setupToolSelection({
    messagesForModel: [{ role: "user", content: "hi" }],
    workspacePath: process.cwd(),
    logger: fakeLogger,
    mode: "agent",
    allowSubAgents,
  });
  return sel.buildTools().map((t) => t.function.name);
}

beforeEach(() => {
  delete process.env.REI_SUBAGENT_ENABLED;
});

describe("setupToolSelection — delegate gating (opt-in flag + depth-1 guard)", () => {
  it("hides `delegate` by default (REI_SUBAGENT_ENABLED unset → opt-in off)", () => {
    expect(toolNames(true)).not.toContain("delegate");
  });

  it("exposes `delegate` at the orchestrator level when REI_SUBAGENT_ENABLED=true", () => {
    process.env.REI_SUBAGENT_ENABLED = "true";
    expect(toolNames(true)).toContain("delegate");
  });

  it("hides `delegate` inside a sub-agent even when enabled (allowSubAgents=false, depth-1)", () => {
    process.env.REI_SUBAGENT_ENABLED = "true";
    expect(toolNames(false)).not.toContain("delegate");
  });
});
