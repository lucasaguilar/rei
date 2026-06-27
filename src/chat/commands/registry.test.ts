import { describe, it, expect } from "vitest";
import { dispatchCommand } from "./registry.js";
import type { ChatSession } from "../types.js";
import type { ModelProvider } from "../../providers/model-provider.js";

const ctx = (command: string) => ({
  command,
  session: { messages: [], mode: "ask" } as ChatSession,
  workspacePath: "/tmp/rei-registry-test-nonexistent",
  provider: {} as unknown as ModelProvider,
});

describe("dispatchCommand (registry)", () => {
  it("returns null for commands not yet migrated → legacy fallback", async () => {
    expect(await dispatchCommand(ctx("/help"))).toBeNull();
    expect(await dispatchCommand(ctx("just a normal prompt"))).toBeNull();
    // Inexact /session inputs must NOT be claimed by the handler (stay behavior-preserving).
    expect(await dispatchCommand(ctx("/session badsubcommand"))).toBeNull();
  });

  it("routes the /session info command to the session handler", async () => {
    const r = await dispatchCommand(ctx("/session"));
    expect(r?.success).toBe(true);
    expect(r?.response).toContain("Current session");
  });
});
