import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { dispatchCommand } from "./registry.js";
import type { CommandContext } from "./command-handler.js";
import type { ChatMessage } from "../types.js";

/**
 * The point of these commands is that the model CANNOT skip the recipe: the skill body is injected
 * into the prompt rather than offered as a choice. So the tests assert on the prompt handed to
 * autoExecute — that is the whole contract.
 */
let ws: string;

const SPEC = `# Spec: Show MCP state

## Goal
Show each MCP server's state.

## Acceptance criteria
1. The list shows each server's connection state.
2. Nothing can be edited from the list.
`;

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), "rei-sdd-"));
});
afterEach(() => rmSync(ws, { recursive: true, force: true }));

const run = (command: string, messages: ChatMessage[] = []) =>
  dispatchCommand({
    command,
    workspacePath: ws,
    session: { messages, mode: "ask" },
  } as unknown as CommandContext);

const promptOf = (r: unknown) =>
  (r as { autoExecute?: { prompt: string } } | null)?.autoExecute?.prompt ?? "";

const specMessage = (): ChatMessage[] => [{ role: "assistant", content: SPEC }];

describe("/spec", () => {
  it("injects the write-spec recipe instead of hoping the model picks it", async () => {
    const r = await run("/spec add a status indicator");
    const p = promptOf(r);
    expect(p).toContain("add a status indicator");
    // A distinctive line from prompts/skills/write-spec.md — proves the body itself is in there.
    expect(p).toContain("Acceptance criteria");
    expect(p).toContain("Out of scope");
  });

  it("switches to planning mode", async () => {
    const r = await run("/spec do a thing");
    expect((r as { newSession?: { mode: string } })?.newSession?.mode).toBe("planning");
  });

  it("tells the model to emit a spec and NOT a plan", async () => {
    const p = promptOf(await run("/spec do a thing"));
    expect(p).toMatch(/not a plan/i);
    expect(p).toMatch(/do NOT decompose/i);
  });

  it("asks for the spec to be persisted, so /savespec is not the only way it survives", async () => {
    const p = promptOf(await run("/spec do a thing"));
    expect(p).toContain(".rei/specs/");
    expect(p).toContain("create_file");
  });

  it("keeps a multi-word task intact", async () => {
    const p = promptOf(await run("/spec migrate the client onboarding flow to signals"));
    expect(p).toContain("migrate the client onboarding flow to signals");
  });
});

describe("/decompose", () => {
  it("refuses without a spec, and names the way forward", async () => {
    const r = await run("/decompose");
    expect((r as { success: boolean }).success).toBe(false);
    expect((r as { response: string }).response).toContain("/spec");
  });

  it("uses the spec from the session", async () => {
    const p = promptOf(await run("/decompose", specMessage()));
    expect(p).toContain("Show MCP state");
    expect(p).toContain("The list shows each server's connection state.");
  });

  it("falls back to the newest file in .rei/specs when the session has none", async () => {
    mkdirSync(join(ws, ".rei", "specs"), { recursive: true });
    writeFileSync(join(ws, ".rei", "specs", "saved.md"), SPEC);
    const r = await run("/decompose");
    expect((r as { success: boolean }).success).toBe(true);
    expect(promptOf(r)).toContain("Show MCP state");
    expect((r as { response: string }).response).toContain(".rei/specs/saved.md");
  });

  it("injects the decomposition recipe", async () => {
    const p = promptOf(await run("/decompose", specMessage()));
    // Distinctive lines from prompts/skills/micro-task-decomposition.md.
    expect(p).toContain("Satisfies:");
    expect(p).toContain("Files to modify:");
  });

  it("demands traceability and the closing verification stages", async () => {
    const p = promptOf(await run("/decompose", specMessage()));
    expect(p).toMatch(/acceptance\s+criterion it serves/i);
    expect(p).toMatch(/verification stages/i);
  });

  it("forbids editing source in this step", async () => {
    const p = promptOf(await run("/decompose", specMessage()));
    expect(p).toMatch(/do NOT edit source/i);
  });
});

describe("command matching", () => {
  it("does not swallow neighbours", async () => {
    expect(await run("/specs")).toBeNull();
    expect(await run("/spec")).toBeNull(); // no task → not ours
    expect(await run("/decomposed")).toBeNull();
  });
});
