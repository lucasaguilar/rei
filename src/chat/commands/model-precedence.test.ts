import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { providerCommands } from "./provider-commands.js";
import { roleCommands } from "./role-commands.js";
import type { CommandContext } from "./command-handler.js";
import type { ChatSession, SessionMode } from "../types.js";

let ws: string;
const saved = { ...process.env };

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), "rei-modeprec-"));
  mkdirSync(join(ws, ".rei", "roles"), { recursive: true });
  writeFileSync(
    join(ws, ".rei", "roles", "reviewer.md"),
    "---\nname: reviewer\ndescription: d\nbaseMode: agent\npreferredModel: role-model\n---\nBody.\n",
  );
  process.env.MODEL_PROVIDER = "lmstudio";
  process.env.LLM_STUDIO_MODEL = "base-model";
  process.env.LLM_STUDIO_MODEL_AGENT = "base-agent-model";
});
afterEach(() => {
  rmSync(ws, { recursive: true, force: true });
  process.env = { ...saved };
});

const session = (over: Partial<ChatSession> = {}): ChatSession =>
  ({ messages: [], mode: "agent" as SessionMode, ...over }) as ChatSession;

const run = async (command: string, s: ChatSession) => {
  const r = await providerCommands.run({ command, session: s, workspacePath: ws } as unknown as CommandContext);
  return { result: r, session: (r as { newSession?: ChatSession }).newSession ?? s };
};

const activate = (name: string, s: ChatSession): ChatSession => {
  const r = roleCommands.run({ command: `/role ${name}`, session: s, workspacePath: ws } as unknown as CommandContext);
  return (r as { newSession?: ChatSession }).newSession ?? s;
};

/**
 * Activating a role and typing `/model` are both deliberate acts, so the rule is: the most recent
 * one wins. Before this, the role always won — `/model` reported "changed successfully" and changed
 * nothing at all while a role was active, which is the worst kind of wrong: a confirmed no-op.
 */
describe("/model outranks an active role", () => {
  it("records the manual choice on the session", async () => {
    const { session: s } = await run("/model agent my-choice", activate("reviewer", session()));
    expect(s.manualModel).toBe("my-choice");
  });

  it("says it is overriding the role, and how to undo it", async () => {
    const { result } = await run("/model agent my-choice", activate("reviewer", session()));
    expect(result.response).toContain("reviewer");
    expect(result.response).toContain("role-model");
    expect(result.response).toContain("/role reviewer");
  });

  it("says nothing about roles when none is active", async () => {
    const { result } = await run("/model agent my-choice", session());
    expect(result.response).not.toContain("Overriding");
  });

  it("says nothing when the choice matches what the role already wanted", async () => {
    const { result } = await run("/model agent role-model", activate("reviewer", session()));
    expect(result.response).not.toContain("Overriding");
  });
});

describe("re-activating a role takes the model back", () => {
  it("clears the manual choice", async () => {
    const { session: overridden } = await run("/model agent my-choice", activate("reviewer", session()));
    expect(activate("reviewer", overridden).manualModel).toBeUndefined();
  });

  it("tells you the manual choice was dropped", () => {
    const s = { ...activate("reviewer", session()), manualModel: "my-choice" };
    const r = roleCommands.run({
      command: "/role reviewer", session: s, workspacePath: ws,
    } as unknown as CommandContext) as { response: string };
    expect(r.response).toContain("dropping your manual choice of my-choice");
  });

  it("does not mention dropping one that equals the role's own model", () => {
    const s = { ...session(), manualModel: "role-model" };
    const r = roleCommands.run({
      command: "/role reviewer", session: s, workspacePath: ws,
    } as unknown as CommandContext) as { response: string };
    expect(r.response).not.toContain("dropping");
  });

  it("clears it on /role off too", () => {
    const s = { ...activate("reviewer", session()), manualModel: "my-choice" };
    const r = roleCommands.run({
      command: "/role off", session: s, workspacePath: ws,
    } as unknown as CommandContext) as { newSession?: ChatSession };
    expect(r.newSession?.manualModel).toBeUndefined();
  });
});

describe("only a choice about the mode you are IN counts", () => {
  it("ignores /model agent while you are in ask mode", async () => {
    // That configures agent for later; it says nothing about the turn you are about to run.
    const { session: s } = await run("/model agent later", session({ mode: "ask" }));
    expect(s.manualModel).toBeUndefined();
  });

  it("ignores a plain /model while you are in agent mode", async () => {
    const { session: s } = await run("/model other", session({ mode: "agent" }));
    expect(s.manualModel).toBeUndefined();
  });

  it("takes a plain /model while you are in ask mode", async () => {
    const { session: s } = await run("/model now", session({ mode: "ask" }));
    expect(s.manualModel).toBe("now");
  });
});
