import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { processMenuCommand } from "../chat/menu-command-processor.js";
import { refreshStickyReading, type ContextBar } from "./helpers/startup-gauge.helper.js";
import type { ChatSession, SessionMode } from "../chat/types.js";

/**
 * The sticky bar is the one line that says which backend a turn will run on, so it is read exactly
 * when something looks wrong — and it was wrong in two ways, both of them a hand-picked `/model`
 * outranking the change you just made:
 *
 *   /model agent X  →  /mode ask    ran ask on X, and the bar said so
 *   /model X        →  /provider ollama   kept X, a model that provider does not have
 *
 * These drive the REAL command processor through the CLI's own sequence (apply newSession, then
 * republish), because the defect was never in either half alone — it was in what survived between.
 */
const saved = { ...process.env };
beforeEach(() => {
  // Strip per-mode overrides that leak from the user's .rei — they would silently override the
  // fixture values and make the test flaky on machines where those vars are set.
  for (const k of [
    "LLM_STUDIO_MODEL_ASK", "OLLAMA_MODEL_ASK",
    "LLM_STUDIO_MODEL_PLANNING", "OLLAMA_MODEL_PLANNING",
  ]) delete process.env[k];

  process.env.MODEL_PROVIDER = "lmstudio";
  process.env.AGENT_MODEL_PROVIDER = "lmstudio";
  process.env.LLM_STUDIO_MODEL = "ask-model";
  process.env.LLM_STUDIO_MODEL_AGENT = "agent-model";
  process.env.OLLAMA_MODEL = "ollama-ask";
  process.env.OLLAMA_MODEL_AGENT = "ollama-agent";
});
afterEach(() => {
  process.env = { ...saved };
});

const agent = { estimateActiveToolsTokens: () => 0 } as never;
const provider = {} as never;
const ws = process.cwd();

const session = (mode: SessionMode): ChatSession =>
  ({ messages: [], mode, createdAt: Date.now() }) as unknown as ChatSession;

/** One CLI command: run it, adopt the session it returns, republish the bar (input-command.helpers). */
async function type(cmd: string, s: ChatSession, bar: ContextBar): Promise<string> {
  const r = await processMenuCommand(cmd, s, ws, provider, {});
  if (r.newSession) Object.assign(s, r.newSession);
  refreshStickyReading(bar, agent, s, ws);
  return r.response;
}

describe("a manual /model does not outlive the mode it was chosen for", () => {
  it("leaves ask on the ask model after /model agent", async () => {
    const s = session("agent");
    const bar: ContextBar = {};
    await type("/model agent picked-by-hand", s, bar);
    expect(bar.modelLabel).toContain("picked-by-hand");

    await type("/mode ask", s, bar);
    expect(bar.modelLabel).toContain("ask-model");
    expect(bar.modelLabel).not.toContain("picked-by-hand");
  });

  it("still honours it on the way back into agent mode", async () => {
    const s = session("agent");
    const bar: ContextBar = {};
    await type("/model agent picked-by-hand", s, bar);
    await type("/mode ask", s, bar);
    await type("/mode agent", s, bar);
    expect(bar.modelLabel).toContain("picked-by-hand");
  });

  it("keeps a base-slot choice across ask ↔ planning, which share the slot", async () => {
    const s = session("ask");
    const bar: ContextBar = {};
    await type("/model picked-by-hand", s, bar);
    await type("/mode planning", s, bar);
    expect(bar.modelLabel).toContain("picked-by-hand");
  });
});

describe("a manual /model does not survive its provider", () => {
  it("hands the slot back when the agent provider changes", async () => {
    const s = session("agent");
    const bar: ContextBar = {};
    await type("/model agent mlx-only-model", s, bar);
    await type("/provider agent ollama", s, bar);
    expect(bar.modelLabel).toContain("ollama / ollama-agent");
    expect(bar.modelLabel).not.toContain("mlx-only-model");
  });

  it("does the same when the dedicated agent provider is switched off", async () => {
    // The fallback only goes somewhere else if the primary provider IS somewhere else: with both
    // set to lmstudio, `/model agent X` wrote LLM_STUDIO_MODEL_AGENT and X stays — correctly.
    process.env.MODEL_PROVIDER = "ollama";
    const s = session("agent");
    const bar: ContextBar = {};
    await type("/model agent mlx-only-model", s, bar);
    await type("/provider agent clear", s, bar);
    expect(bar.modelLabel).toContain("ollama / ollama-agent");
    expect(bar.modelLabel).not.toContain("mlx-only-model");
  });

  it("leaves the OTHER slot's choice alone", async () => {
    // `/provider agent ollama` says nothing about the ask/planning provider, so the choice made
    // there is still reachable — clearing it would be the same bug pointed the other way.
    const s = session("ask");
    const bar: ContextBar = {};
    await type("/model chosen-for-ask", s, bar);
    await type("/provider agent ollama", s, bar);
    expect(bar.modelLabel).toContain("chosen-for-ask");
  });

  it("hands the base slot back when the primary provider changes", async () => {
    const s = session("ask");
    const bar: ContextBar = {};
    await type("/model chosen-for-ask", s, bar);
    await type("/provider ollama", s, bar);
    expect(bar.modelLabel).toContain("ollama-ask");
    expect(bar.modelLabel).not.toContain("chosen-for-ask");
  });
});

describe("the bar keeps tracking what it already tracked", () => {
  it("follows /model agent in agent mode", async () => {
    const s = session("agent");
    const bar: ContextBar = {};
    await type("/model agent fresh-agent-model", s, bar);
    expect(bar.modelLabel).toContain("fresh-agent-model");
  });

  it("re-reads the model on /mode agent when the env changed underneath", async () => {
    const s = session("agent");
    const bar: ContextBar = {};
    await type("/mode agent", s, bar);
    process.env.LLM_STUDIO_MODEL_AGENT = "swapped-out";
    await type("/mode agent", s, bar);
    expect(bar.modelLabel).toContain("swapped-out");
  });

  it("names the provider it is talking to", async () => {
    const s = session("agent");
    const bar: ContextBar = {};
    await type("/mode agent", s, bar);
    expect(bar.modelLabel).toContain("lmstudio");
  });
});
