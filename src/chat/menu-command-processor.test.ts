import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { processMenuCommand } from "./menu-command-processor.js";
import { listSessions, loadCurrentSession, saveSession } from "./session-store.js";
import type { ChatSession } from "./types.js";
import type { ModelProvider } from "../providers/model-provider.js";

describe("menu-command-processor session commands", () => {
  let tmpWorkspace: string;
  const provider = {} as ModelProvider;

  beforeEach(async () => {
    tmpWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), "rei-session-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpWorkspace, { recursive: true, force: true });
  });

  it("starts a new session without sending /session new to the model", async () => {
    const session: ChatSession = {
      mode: "ask",
      createdAt: "2026-05-16T00:00:00.000Z",
      messages: [
        { role: "user", content: "old question" },
        { role: "assistant", content: "old answer" },
      ],
    };

    saveSession(
      tmpWorkspace,
      session.messages,
      session.mode,
      session.summary,
      session.createdAt,
    );

    const result = await processMenuCommand(
      "/session new",
      session,
      tmpWorkspace,
      provider,
    );

    expect(result.success).toBe(true);
    expect(result.recordInSession).toBe(false);
    expect(result.newSession).toEqual({ messages: [], mode: "ask" });

    const current = loadCurrentSession(tmpWorkspace);
    expect(current?.messages).toEqual([]);
    expect(current?.mode).toBe("ask");

    const archived = listSessions(tmpWorkspace);
    expect(archived).toHaveLength(1);
    expect(archived[0].turns).toBe(1);
  });

  it("archives session with a custom descriptive name via /session new", async () => {
    const session: ChatSession = {
      mode: "ask",
      createdAt: "2026-05-16T00:00:00.000Z",
      messages: [
        { role: "user", content: "old question" },
        { role: "assistant", content: "old answer" },
      ],
    };

    saveSession(tmpWorkspace, session.messages, session.mode, session.summary, session.createdAt);

    const result = await processMenuCommand("/session new agregar-login-social", session, tmpWorkspace, provider);

    expect(result.success).toBe(true);
    expect(result.response).toContain("agregar-login-social.json");
    expect(result.newSession).toEqual({ messages: [], mode: "ask" });

    const archived = listSessions(tmpWorkspace);
    expect(archived).toHaveLength(1);
    expect(archived[0].id).toBe("agregar-login-social");
  });

  it("archives session with a custom name via /session archive", async () => {
    const session: ChatSession = {
      mode: "agent",
      createdAt: "2026-05-16T00:00:00.000Z",
      messages: [{ role: "user", content: "do something" }],
    };

    saveSession(tmpWorkspace, session.messages, session.mode, session.summary, session.createdAt);

    const result = await processMenuCommand("/session archive fix-bug-123", session, tmpWorkspace, provider);

    expect(result.success).toBe(true);
    expect(result.response).toContain("fix-bug-123.json");
    expect(result.newSession).toEqual({ messages: [], mode: "agent" });

    const archived = listSessions(tmpWorkspace);
    expect(archived).toHaveLength(1);
    expect(archived[0].id).toBe("fix-bug-123");
  });

  it("handles name collisions by appending a numeric suffix", async () => {
    const session: ChatSession = {
      mode: "ask",
      createdAt: "2026-05-16T00:00:00.000Z",
      messages: [{ role: "user", content: "msg1" }],
    };

    saveSession(tmpWorkspace, session.messages, session.mode, session.summary, session.createdAt);
    await processMenuCommand("/session new my-feature", session, tmpWorkspace, provider);

    // Create a new session and archive with the same name
    const session2: ChatSession = {
      mode: "ask",
      messages: [{ role: "user", content: "msg2" }],
    };
    saveSession(tmpWorkspace, session2.messages, session2.mode);
    const result2 = await processMenuCommand("/session new my-feature", session2, tmpWorkspace, provider);

    expect(result2.success).toBe(true);
    expect(result2.response).toContain("my-feature-1.json");

    const archived = listSessions(tmpWorkspace);
    expect(archived).toHaveLength(2);
    const ids = archived.map((s) => s.id).sort();
    expect(ids).toEqual(["my-feature", "my-feature-1"]);
  });
});

describe("menu-command-processor /provider and /model commands", () => {
  let tmpWorkspace: string;
  const provider = {} as ModelProvider;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(async () => {
    tmpWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), "rei-model-provider-test-"));
    originalEnv = { ...process.env };
  });

  afterEach(async () => {
    await fs.rm(tmpWorkspace, { recursive: true, force: true });
    process.env = originalEnv;
  });

  it("handles /provider command correctly", async () => {
    process.env.MODEL_PROVIDER = "ollama";
    const session: ChatSession = { mode: "ask", messages: [] };

    // Get current provider
    const getResult = await processMenuCommand("/provider", session, tmpWorkspace, provider);
    expect(getResult.success).toBe(true);
    expect(getResult.response).toContain("Active provider (Ask/Planning): 'ollama'");

    // Switch to valid provider
    const setValidResult = await processMenuCommand("/provider gemini", session, tmpWorkspace, provider);
    expect(setValidResult.success).toBe(true);
    expect(setValidResult.recreateAgent).toBe(true);
    expect(process.env.MODEL_PROVIDER).toBe("gemini");

    // Switch to invalid provider
    const setInvalidResult = await processMenuCommand("/provider invalid_one", session, tmpWorkspace, provider);
    expect(setInvalidResult.success).toBe(false);
    expect(setInvalidResult.response).toContain("Unknown provider: 'invalid_one'");
  });

  it("handles /model command correctly", async () => {
    process.env.MODEL_PROVIDER = "ollama";
    process.env.OLLAMA_MODEL = "qwen2.5-coder";
    const session: ChatSession = { mode: "ask", messages: [] };

    // Get current model
    const getResult = await processMenuCommand("/model", session, tmpWorkspace, provider);
    expect(getResult.success).toBe(true);
    expect(getResult.response).toContain("Active model for Ask/Planning ('ollama'): 'qwen2.5-coder'");

    // Switch model for ollama
    const setResult = await processMenuCommand("/model codegemma", session, tmpWorkspace, provider);
    expect(setResult.success).toBe(true);
    expect(setResult.recreateAgent).toBe(true);
    expect(process.env.OLLAMA_MODEL).toBe("codegemma");
    expect(process.env.OLLAMA_MODEL_ASK).toBe("codegemma");
  });

  it("handles /provider agent command correctly", async () => {
    process.env.MODEL_PROVIDER = "ollama";
    process.env.AGENT_MODEL_PROVIDER = "openrouter";
    const session: ChatSession = { mode: "ask", messages: [] };

    // Get current agent provider
    const getResult = await processMenuCommand("/provider agent", session, tmpWorkspace, provider);
    expect(getResult.success).toBe(true);
    expect(getResult.response).toContain("Dedicated Agent provider: 'openrouter'");

    // Switch dedicated agent provider
    const setResult = await processMenuCommand("/provider agent gemini", session, tmpWorkspace, provider);
    expect(setResult.success).toBe(true);
    expect(setResult.recreateAgent).toBe(true);
    expect(process.env.AGENT_MODEL_PROVIDER).toBe("gemini");

    // Disable dedicated agent provider
    const clearResult = await processMenuCommand("/provider agent clear", session, tmpWorkspace, provider);
    expect(clearResult.success).toBe(true);
    expect(clearResult.recreateAgent).toBe(true);
    expect(process.env.AGENT_MODEL_PROVIDER).toBe("");
  });

  it("handles /model agent command correctly", async () => {
    process.env.MODEL_PROVIDER = "ollama";
    process.env.AGENT_MODEL_PROVIDER = "openrouter";
    process.env.OPENROUTER_MODEL_AGENT = "qwen/qwen3.6-plus";
    const session: ChatSession = { mode: "ask", messages: [] };

    // Get current agent model
    const getResult = await processMenuCommand("/model agent", session, tmpWorkspace, provider);
    expect(getResult.success).toBe(true);
    expect(getResult.response).toContain("Active model for Agent ('openrouter'): 'qwen/qwen3.6-plus'");

    // Change dedicated agent model
    const setResult = await processMenuCommand("/model agent google/gemini-2.5-pro", session, tmpWorkspace, provider);
    expect(setResult.success).toBe(true);
    expect(setResult.recreateAgent).toBe(true);
    expect(process.env.OPENROUTER_MODEL_AGENT).toBe("google/gemini-2.5-pro");
  });
});
