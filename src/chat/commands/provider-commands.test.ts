import { describe, it, expect, afterEach } from "vitest";
import { providerCommands } from "./provider-commands.js";
import type { ChatSession } from "../types.js";
import type { ModelProvider } from "../../providers/model-provider.js";

const ENV_KEYS = [
  "MODEL_PROVIDER",
  "AGENT_MODEL_PROVIDER",
  "OPENROUTER_MODEL",
  "GROQ_MODEL_AGENT",
] as const;
const saved: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) saved[k] = process.env[k];

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const ctx = (command: string) => ({
  command,
  workspacePath: "/tmp/rei-provcmd-test",
  session: { messages: [], mode: "ask" } as ChatSession,
  provider: {} as unknown as ModelProvider,
});

describe("providerCommands handler", () => {
  it("matches /provider and /model (incl. agent forms) but not others", () => {
    expect(providerCommands.match("/provider")).toBe(true);
    expect(providerCommands.match("/provider agent openrouter")).toBe(true);
    expect(providerCommands.match("/model llama-3")).toBe(true);
    expect(providerCommands.match("/help")).toBe(false);
    expect(providerCommands.match("/providerxyz")).toBe(false);
  });

  it("/provider with no arg shows the active provider", async () => {
    process.env.MODEL_PROVIDER = "openrouter";
    const r = await providerCommands.run(ctx("/provider"));
    expect(r.success).toBe(true);
    expect(r.response).toContain("openrouter");
  });

  it("/provider rejects an unknown provider", async () => {
    const r = await providerCommands.run(ctx("/provider banana"));
    expect(r.success).toBe(false);
    expect(r.response).toContain("Unknown provider");
  });

  it("/provider <name> switches and asks to recreate the agent", async () => {
    const r = await providerCommands.run(ctx("/provider groq"));
    expect(r.success).toBe(true);
    expect(r.recreateAgent).toBe(true);
    expect(process.env.MODEL_PROVIDER).toBe("groq");
  });

  it("/model agent <name> sets the agent model env var", async () => {
    process.env.AGENT_MODEL_PROVIDER = "groq";
    const r = await providerCommands.run(ctx("/model agent llama-3"));
    expect(r.success).toBe(true);
    expect(process.env.GROQ_MODEL_AGENT).toBe("llama-3");
  });
});
