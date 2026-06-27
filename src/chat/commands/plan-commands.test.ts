import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runPlanCommand, planFileCommands } from "./plan-commands.js";
import type { ChatSession } from "../types.js";
import type { ModelProvider } from "../../providers/model-provider.js";

let ws: string;
beforeAll(() => {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), "rei-plan-test-"));
});
afterAll(() => fs.rmSync(ws, { recursive: true, force: true }));

const ctx = (command: string) => ({
  command,
  workspacePath: ws,
  session: { messages: [], mode: "ask" } as ChatSession,
  provider: {} as unknown as ModelProvider,
});

describe("runPlanCommand handler", () => {
  it("matches /runplan (and stage form) but not other plan commands", () => {
    expect(runPlanCommand.match("/runplan")).toBe(true);
    expect(runPlanCommand.match("/runplan stage 2")).toBe(true);
    expect(runPlanCommand.match("/saveplan x")).toBe(false);
    expect(runPlanCommand.match("/help")).toBe(false);
  });

  it("rejects an invalid format", async () => {
    const r = await runPlanCommand.run(ctx("/runplan stage abc"));
    expect(r.success).toBe(false);
    expect(r.response).toContain("Invalid format");
  });

  it("reports when no plan exists in the session", async () => {
    const r = await runPlanCommand.run(ctx("/runplan"));
    expect(r.success).toBe(false);
    expect(r.response).toContain("No plan was found");
  });
});

describe("planFileCommands handler", () => {
  it("matches saveplan/loadplan but not runplan", () => {
    expect(planFileCommands.match("/saveplan x")).toBe(true);
    expect(planFileCommands.match("/loadplan x")).toBe(true);
    expect(planFileCommands.match("/runplan")).toBe(false);
  });

  it("/saveplan without a name → invalid format", async () => {
    const r = await planFileCommands.run(ctx("/saveplan"));
    expect(r.success).toBe(false);
    expect(r.response).toContain("Invalid format");
  });

  it("/saveplan with no plan in the session reports nothing to save", async () => {
    const r = await planFileCommands.run(ctx("/saveplan my-plan"));
    expect(r.success).toBe(false);
    expect(r.response).toContain("No plan was found");
  });

  it("/loadplan a missing plan reports an error", async () => {
    const r = await planFileCommands.run(ctx("/loadplan nonexistent-plan-xyz"));
    expect(r.success).toBe(false);
    expect(r.response).toContain("Error loading plan");
  });
});
