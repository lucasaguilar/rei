import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { processMenuCommand } from "./menu-command-processor.js";
import {
  getActiveSessionId,
  listSessions,
  loadCurrentSession,
  saveSession,
  setActiveSession,
} from "./session-store.js";
import {
  saveCurrentPlanContent,
  loadCurrentPlanContent,
  getTotalStagesInPlan,
} from "./plan-tracker.js";
import * as fsSync from "node:fs";
import type { ChatSession } from "./types.js";
import type { ModelProvider } from "../providers/model-provider.js";

// The /runplan tests below cover plan ROUTING — which plan, which stage, which files — on the
// single-session path. Stage delegation is on by default and would hand each stage to a sub-agent
// that this stub provider cannot answer; it has its own tests in agent-mode/plan-delegation.test.ts.
process.env.REI_RUNPLAN_DELEGATE = "false";

describe("menu-command-processor session commands", () => {
  let tmpWorkspace: string;
  const provider = {} as ModelProvider;

  beforeEach(async () => {
    tmpWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), "rei-session-test-"));
    // The active session file is module state, and `/session save-as` rebinds it. Reset it per test
    // so one test's rename cannot decide where the next one writes.
    setActiveSession("current");
  });

  afterEach(async () => {
    await fs.rm(tmpWorkspace, { recursive: true, force: true });
  });

  it("/mode agent->ask KEEPS the conversation (drops only tool plumbing)", async () => {
    const session: ChatSession = {
      mode: "agent",
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "align the icons" },
        { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "edit_file", arguments: "{}" } }] },
        { role: "tool", content: "OK applied", tool_call_id: "c1" },
        { role: "assistant", content: "Done — aligned the icons in 3 files." },
      ],
    };
    const result = await processMenuCommand("/mode ask", session, tmpWorkspace, provider);
    expect(result.success).toBe(true);
    const kept = result.newSession!.messages;
    // Conversation prose survives:
    expect(kept.some((m) => m.role === "user" && m.content === "align the icons")).toBe(true);
    expect(kept.some((m) => m.content.includes("aligned the icons in 3 files"))).toBe(true);
    // Tool plumbing is gone:
    expect(kept.some((m) => m.role === "tool")).toBe(false);
    expect(kept.some((m) => m.tool_calls)).toBe(false);
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
    expect(result.newSession).toEqual({ messages: [], mode: "agent" });

    const current = loadCurrentSession(tmpWorkspace);
    expect(current?.messages).toEqual([]);
    expect(current?.mode).toBe("agent");

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
    expect(result.newSession).toEqual({ messages: [], mode: "agent" });

    const archived = listSessions(tmpWorkspace);
    expect(archived).toHaveLength(1);
    // Now always prefixed with the archive timestamp, then the custom name.
    expect(archived[0].id).toMatch(/^\d{4}-\d{2}-\d{2}-\d{6}-agregar-login-social$/);
  });

  it("/session load binds to the loaded session, so further turns go back into it", async () => {
    const dir = path.join(tmpWorkspace, ".rei/sessions");
    fsSync.mkdirSync(dir, { recursive: true });
    fsSync.writeFileSync(
      path.join(dir, "ayer.json"),
      JSON.stringify({
        version: 1,
        workspace: tmpWorkspace,
        mode: "agent",
        createdAt: "2026-05-01T00:00:00.000Z",
        updatedAt: "2026-05-01T00:00:00.000Z",
        messages: [{ role: "user", content: "lo de ayer" }],
      }),
    );

    const session: ChatSession = { mode: "agent", messages: [] };
    const result = await processMenuCommand("/session load ayer", session, tmpWorkspace, provider);
    expect(result.success).toBe(true);

    // The point of the fix: the loaded session is now the ACTIVE file. Before, the load copied the
    // messages into this instance's own file and left `ayer.json` frozen — every turn that followed
    // was written somewhere the user never asked for.
    expect(getActiveSessionId()).toBe("ayer");
    saveSession(tmpWorkspace, [...result.newSession!.messages, { role: "user", content: "y hoy" }], "agent");
    const reread = JSON.parse(fsSync.readFileSync(path.join(dir, "ayer.json"), "utf8"));
    expect(reread.messages).toHaveLength(2);
  });

  it("/session load refuses a session another terminal holds open", async () => {
    const dir = path.join(tmpWorkspace, ".rei/sessions");
    fsSync.mkdirSync(dir, { recursive: true });
    fsSync.writeFileSync(
      path.join(dir, "ocupada.json"),
      JSON.stringify({
        version: 1, workspace: tmpWorkspace, mode: "agent",
        createdAt: "2026-05-01T00:00:00.000Z", updatedAt: "2026-05-01T00:00:00.000Z",
        messages: [{ role: "user", content: "x" }],
      }),
    );
    // pid 1 always exists and is never us, so the lock reads as held by a live foreign process.
    fsSync.writeFileSync(
      path.join(dir, "ocupada.lock"),
      JSON.stringify({ pid: 1, startedAt: "2026-05-01T00:00:00.000Z" }),
    );

    const session: ChatSession = { mode: "agent", messages: [] };
    const result = await processMenuCommand("/session load ocupada", session, tmpWorkspace, provider);

    expect(result.success).toBe(false);
    expect(result.response).toContain("another terminal");
    expect(getActiveSessionId()).toBe("current"); // we did not switch into it
  });

  it("names the session via /session save-as WITHOUT ending it", async () => {
    const session: ChatSession = {
      mode: "agent",
      createdAt: "2026-05-16T00:00:00.000Z",
      messages: [{ role: "user", content: "do something" }],
    };

    saveSession(tmpWorkspace, session.messages, session.mode, session.summary, session.createdAt);

    const result = await processMenuCommand("/session save-as nombre-lindo", session, tmpWorkspace, provider);

    expect(result.success).toBe(true);
    // The contrast with /session archive, which is the whole reason this command exists: archive
    // hands back an EMPTY newSession (the session is over), save-as hands back none at all, so the
    // caller keeps the session it is already holding.
    expect(result.newSession).toBeUndefined();

    const sessions = listSessions(tmpWorkspace);
    expect(sessions.map((s) => s.id)).toEqual(["nombre-lindo"]);
    expect(sessions[0].createdAt).toBe("2026-05-16T00:00:00.000Z");
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
    expect(archived[0].id).toMatch(/^\d{4}-\d{2}-\d{2}-\d{6}-fix-bug-123$/);
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

    const archived = listSessions(tmpWorkspace);
    expect(archived).toHaveLength(2);
    // Both carry the timestamp prefix + name; same-second archives get a -N collision suffix.
    expect(archived.every((s) => /^\d{4}-\d{2}-\d{2}-\d{6}.*my-feature/.test(s.id))).toBe(true);
    expect(new Set(archived.map((s) => s.id)).size).toBe(2); // distinct files
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
    // Deprecated per-mode var is no longer written (uniform: ask/planning use OLLAMA_MODEL).
    expect(process.env.OLLAMA_MODEL_ASK).not.toBe("codegemma");
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

describe("menu-command-processor /runplan and plan-tracker lifecycle", () => {
  let tmpWorkspace: string;
  const provider = {} as ModelProvider;

  beforeEach(async () => {
    tmpWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), "rei-runplan-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpWorkspace, { recursive: true, force: true });
  });

  it("creates and parses stages from a plan with /runplan stage <num>", async () => {
    const planText = `
# Implementation Plan

## Proposed Changes

### Stage 1: Setup auth module
We need to edit auth.ts.
- Modify [auth.ts](file:///Users/dev/www/rei/auth.ts)

### Stage 2: Integrate routes
We need to edit router.ts.
- Modify [router.ts](file:///Users/dev/www/rei/router.ts)

## Verification
Done.
    `;

    const session: ChatSession = {
      mode: "planning",
      messages: [
        { role: "assistant", content: planText }
      ]
    };

    // 1. Run "/runplan stage 1"
    const result1 = await processMenuCommand("/runplan stage 1", session, tmpWorkspace, provider);
    expect(result1.success).toBe(true);
    expect(result1.response).toContain("stage 1");
    expect(result1.autoExecute?.prompt).toContain("[RUNPLAN STAGE 1]");
    expect(result1.autoExecute?.prompt).toContain("auth.ts");
    expect(result1.autoExecute?.prompt).not.toContain("router.ts");

    // SOURCE: the active plan content is persisted (no todo checklist), and the
    // stage count is derived from it.
    expect(loadCurrentPlanContent(tmpWorkspace)).toContain("Stage 1: Setup auth module");
    expect(getTotalStagesInPlan(tmpWorkspace)).toBe(2);
    // No checklist file is ever created.
    expect(fsSync.existsSync(path.join(tmpWorkspace, ".rei", "current-plan-todo.md"))).toBe(false);

    // 3. Run "/runplan stage 2"
    const result2 = await processMenuCommand("/runplan stage 2", session, tmpWorkspace, provider);
    expect(result2.success).toBe(true);
    expect(result2.response).toContain("stage 2");
    expect(result2.autoExecute?.prompt).toContain("[RUNPLAN STAGE 2]");
    expect(result2.autoExecute?.prompt).toContain("router.ts");
    expect(result2.autoExecute?.prompt).not.toContain("auth.ts");

    // 4. Lifecycle - new session clears the active plan
    await processMenuCommand("/session new", session, tmpWorkspace, provider);
    expect(loadCurrentPlanContent(tmpWorkspace)).toBeNull();
  });

  it("clears the active plan on /clear and restores it on session load", async () => {
    const planText = `
# Implementation Plan
### Stage 1: Fix bug
Modify [app.ts](file:///Users/dev/www/rei/app.ts)
    `;

    const session: ChatSession = {
      mode: "planning",
      messages: [
        { role: "assistant", content: planText, sourceMode: "planning" }
      ]
    };

    saveCurrentPlanContent(tmpWorkspace, planText);
    expect(loadCurrentPlanContent(tmpWorkspace)).not.toBeNull();

    // 1. /clear wipes the active plan
    await processMenuCommand("/clear", session, tmpWorkspace, provider);
    expect(loadCurrentPlanContent(tmpWorkspace)).toBeNull();

    // 2. Loading a session restores the active plan from its last planning message
    saveSession(tmpWorkspace, session.messages, session.mode, session.summary, "2026-05-26T20:59:58Z");
    const activeSessions = listSessions(tmpWorkspace);
    if (activeSessions.length > 0) {
      const sessionId = activeSessions[0].id;
      const loadRes = await processMenuCommand(`/session load ${sessionId}`, { mode: "planning", messages: [] }, tmpWorkspace, provider);
      expect(loadRes.success).toBe(true);
      expect(loadCurrentPlanContent(tmpWorkspace)).toContain("Stage 1: Fix bug");
    }
  });

  it("counts stages from flexible plan formats (lists and bullets)", async () => {
    const flexiblePlanText = `
- [ ] **Stage 1:** Limpiar app.html (eliminar datos corruptos/binarios)
  - [ ] **1. Subtarea** (this should not match)
1. **Stage 2:** Verificar que DashboardComponent se renderice
  - [ ] **2. Subtarea** (this should not match)
- Stage 3: Verificar imports de Material
### 📦 Stage 4: Capa de Datos (Services + Mock)
- [ ] **5. Crear DollarService** (this should not match)
    `;

    saveCurrentPlanContent(tmpWorkspace, flexiblePlanText);
    // Four distinct stages, subtasks/bullets excluded.
    expect(getTotalStagesInPlan(tmpWorkspace)).toBe(4);
  });

  it("handles /saveplan and /loadplan commands", async () => {
    const planText = `
### 📦 Stage 1: Capa de Datos (Services + Mock)
We need to edit auth.ts.
- Modify [auth.ts](file:///Users/dev/www/rei/auth.ts)
    `;

    const session: ChatSession = {
      mode: "planning",
      messages: [
        { role: "assistant", content: planText }
      ]
    };

    // 1. Run "/saveplan my-cool-plan"
    const saveResult = await processMenuCommand("/saveplan my-cool-plan", session, tmpWorkspace, provider);
    expect(saveResult.success).toBe(true);
    expect(saveResult.response).toContain("Full plan saved successfully");

    // 2. Load the plan into a new session
    const emptySession: ChatSession = {
      mode: "planning",
      messages: []
    };
    const loadResult = await processMenuCommand("/loadplan my-cool-plan", emptySession, tmpWorkspace, provider);
    expect(loadResult.success).toBe(true);
    expect(loadResult.response).toContain("Plan 'my-cool-plan' loaded");
    expect(loadResult.newSession?.messages.length).toBe(1);
    expect(loadResult.newSession?.messages[0].content).toBe(planText);

    // The loaded plan becomes the active SOURCE (no todo checklist).
    expect(loadCurrentPlanContent(tmpWorkspace)).toContain("Capa de Datos (Services + Mock)");

    // 3. Test `/runplan stage 1` on loaded plan
    const runResult = await processMenuCommand("/runplan stage 1", loadResult.newSession!, tmpWorkspace, provider);
    expect(runResult.success).toBe(true);
    expect(runResult.autoExecute?.prompt).toContain("[RUNPLAN STAGE 1]");
    expect(runResult.autoExecute?.prompt).toContain("auth.ts");
  });

  it("dynamically parses files from polyglot plans (C#, Python, Rust, Go, PHP)", async () => {
    const polyglotPlanText = `
### Stage 1: Implement Backend Logic
We need to edit several files across languages.
- Modify [Program.cs](file:///Users/dev/www/rei/Program.cs)
- Modify [app.py](file:///Users/dev/www/rei/app.py)
- Modify [main.rs](file:///Users/dev/www/rei/main.rs)
- Modify [handler.go](file:///Users/dev/www/rei/handler.go)
- Modify [index.php](file:///Users/dev/www/rei/index.php)
    `;

    const session: ChatSession = {
      mode: "planning",
      messages: [
        { role: "assistant", content: polyglotPlanText }
      ]
    };

    const result = await processMenuCommand("/runplan stage 1", session, tmpWorkspace, provider);
    expect(result.success).toBe(true);
    expect(result.autoExecute?.prompt).toContain("Program.cs");
    expect(result.autoExecute?.prompt).toContain("app.py");
    expect(result.autoExecute?.prompt).toContain("main.rs");
    expect(result.autoExecute?.prompt).toContain("handler.go");
    expect(result.autoExecute?.prompt).toContain("index.php");
  });
});

