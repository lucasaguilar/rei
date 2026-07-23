import { describe, it, expect, vi } from "vitest";
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

describe("setupToolSelection — delegate gating (depth-1 guard)", () => {
  it("exposes `delegate` at the orchestrator level (allowSubAgents=true)", () => {
    expect(toolNames(true)).toContain("delegate");
  });

  it("hides `delegate` inside a sub-agent (allowSubAgents=false) → no nesting", () => {
    expect(toolNames(false)).not.toContain("delegate");
  });
});
