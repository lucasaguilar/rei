import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { dispatchCommand } from "./registry.js";
import type { CommandContext } from "./command-handler.js";
import {
  getThinkingOverride,
  setThinkingOverride,
  resolveReasoningEffort,
} from "../../config/model-runtime.js";

/**
 * `/think` sends a reasoning level for the running session without a restart. Two things it must NOT
 * do: let an invalid value through (the field is validated server-side — LM Studio 400s on anything
 * outside the set, which would fail the turn), and claim the level was APPLIED when all REI controls
 * is that it was sent.
 */
const run = (command: string) =>
  dispatchCommand({ command } as unknown as CommandContext);

const ENV_KEYS = ["REI_REASONING_EFFORT_ASK", "REI_REASONING_EFFORT_AGENT"] as const;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  setThinkingOverride(undefined);
});
afterEach(() => {
  setThinkingOverride(undefined);
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k]!;
  }
});

describe("/think", () => {
  it("sets a valid level", async () => {
    const r = await run("/think low");
    expect(r?.success).toBe(true);
    expect(getThinkingOverride()).toBe("low");
  });

  it("the override wins over the env, for every mode", async () => {
    process.env.REI_REASONING_EFFORT_ASK = "medium";
    process.env.REI_REASONING_EFFORT_AGENT = "high";
    await run("/think xhigh");
    expect(resolveReasoningEffort("ask")).toBe("xhigh");
    expect(resolveReasoningEffort("agent")).toBe("xhigh");
  });

  it("/think off restores the env values", async () => {
    process.env.REI_REASONING_EFFORT_AGENT = "medium";
    await run("/think low");
    await run("/think off");
    expect(getThinkingOverride()).toBeUndefined();
    expect(resolveReasoningEffort("agent")).toBe("medium");
  });

  it("rejects an invalid level instead of sending it (it would 400 server-side)", async () => {
    const r = await run("/think notalevel");
    expect(r?.success).toBe(false);
    expect(r?.response).toMatch(/is not a valid level/);
    expect(getThinkingOverride()).toBeUndefined();
  });

  it("does not clobber an active override when a later value is invalid", async () => {
    await run("/think low");
    await run("/think bogus");
    expect(getThinkingOverride()).toBe("low");
  });

  it("accepts every value the API documents, none included", async () => {
    for (const level of ["none", "minimal", "low", "medium", "high", "xhigh"]) {
      const r = await run(`/think ${level}`);
      expect(r?.success, level).toBe(true);
      expect(getThinkingOverride()).toBe(level);
    }
  });

  it("is case-insensitive", async () => {
    await run("/think XHIGH");
    expect(getThinkingOverride()).toBe("xhigh");
  });

  it("bare /think reports the source, and lists the levels", async () => {
    process.env.REI_REASONING_EFFORT_AGENT = "medium";
    const off = await run("/think");
    expect(off?.response).toMatch(/no override/);
    expect(off?.response).toMatch(/agent=medium/);

    await run("/think low");
    const on = await run("/think");
    expect(on?.response).toMatch(/session override/);
  });

  it("says the level is SENT, not applied — the backend decides", async () => {
    const r = await run("/think medium");
    expect(r?.response).toMatch(/sent from the next turn/);
    expect(r?.response).not.toMatch(/\bapplied\b/);
  });

  it("does not swallow other commands", async () => {
    expect(await run("/thinking")).toBeNull();
    expect(await run("/think low extra")).toBeNull();
  });

  it("is not recorded in the conversation history", async () => {
    expect((await run("/think low"))?.recordInSession).toBe(false);
  });
});
