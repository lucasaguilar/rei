import { describe, it, expect, afterEach } from "vitest";
import { miscCommands } from "./misc-commands.js";
import type { ChatSession } from "../types.js";
import type { ModelProvider } from "../../providers/model-provider.js";

const ctx = (command: string, mode: ChatSession["mode"] = "ask") => ({
  command,
  workspacePath: "/tmp/rei-misc-test-nonexistent",
  session: { messages: [], mode } as ChatSession,
  provider: {} as unknown as ModelProvider,
});

describe("miscCommands handler", () => {
  const savedTdd = process.env.REI_TDD_MODE;
  afterEach(() => {
    if (savedTdd === undefined) delete process.env.REI_TDD_MODE;
    else process.env.REI_TDD_MODE = savedTdd;
  });

  it("matches its commands but not others (behavior-preserving)", () => {
    expect(miscCommands.match("/help")).toBe(true);
    expect(miscCommands.match("/tdd")).toBe(true);
    expect(miscCommands.match("/reloadprompts")).toBe(true);
    expect(miscCommands.match("/mode agent")).toBe(true);
    expect(miscCommands.match("/mode")).toBe(false); // no arg → legacy fallback
    expect(miscCommands.match("/ask-document x q")).toBe(false);
  });

  it("/help returns the command list", async () => {
    const r = await miscCommands.run(ctx("/help"));
    expect(r.success).toBe(true);
    expect(r.response).toContain("Available commands");
  });

  it("/tdd toggles REI_TDD_MODE", async () => {
    process.env.REI_TDD_MODE = "false";
    const r = await miscCommands.run(ctx("/tdd"));
    expect(process.env.REI_TDD_MODE).toBe("true");
    expect(r.response).toContain("activated");
  });

  it("/mode rejects an invalid mode", async () => {
    const r = await miscCommands.run(ctx("/mode banana"));
    expect(r.success).toBe(false);
    expect(r.response).toContain("Unknown mode");
  });
});
