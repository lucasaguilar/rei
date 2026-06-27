import { describe, it, expect } from "vitest";
import { specCommands } from "./spec-commands.js";
import type { ChatSession } from "../types.js";
import type { ModelProvider } from "../../providers/model-provider.js";

const ctx = (command: string) => ({
  command,
  workspacePath: "/tmp/rei-spec-test-nonexistent",
  session: { messages: [], mode: "ask" } as ChatSession,
  provider: {} as unknown as ModelProvider,
});

describe("specCommands handler", () => {
  it("matches savespec/loadspec but not others", () => {
    expect(specCommands.match("/savespec foo")).toBe(true);
    expect(specCommands.match("/loadspec foo")).toBe(true);
    expect(specCommands.match("/savespec")).toBe(true); // owned → returns invalid-format
    expect(specCommands.match("/help")).toBe(false);
  });

  it("/savespec without a name returns invalid format", async () => {
    const r = await specCommands.run(ctx("/savespec"));
    expect(r.success).toBe(false);
    expect(r.response).toContain("Invalid format");
  });

  it("/savespec with no spec in the session reports nothing to save", async () => {
    const r = await specCommands.run(ctx("/savespec my-spec"));
    expect(r.success).toBe(false);
    expect(r.response).toContain("No spec was found");
  });

  it("/loadspec without a name returns invalid format", async () => {
    const r = await specCommands.run(ctx("/loadspec"));
    expect(r.success).toBe(false);
    expect(r.response).toContain("Invalid format");
  });
});
