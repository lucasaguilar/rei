import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { processMenuCommand } from "./menu-command-processor.js";
import { listSessions, loadCurrentSession, saveSession } from "./session-store.js";
import {
  readPlanTodoFile,
  markStageAsCompleted,
  deletePlanTodoFile,
  initPlanTodoFile,
} from "./plan-tracker.js";
import * as fsSync from "node:fs";
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
- Modify [auth.ts](file:///Users/lucas/www/rei/auth.ts)

### Stage 2: Integrate routes
We need to edit router.ts.
- Modify [router.ts](file:///Users/lucas/www/rei/router.ts)

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

    // Verify .rei/current-plan-todo.md exists
    const todoContent = readPlanTodoFile(tmpWorkspace);
    expect(todoContent).not.toBeNull();
    expect(todoContent).toContain("- [ ] **Etapa 1:** Setup auth module");
    expect(todoContent).toContain("- [ ] **Etapa 2:** Integrate routes");

    // 2. Mark stage 1 completed
    markStageAsCompleted(tmpWorkspace, 1);
    const todoContent2 = readPlanTodoFile(tmpWorkspace);
    expect(todoContent2).toContain("- [x] **Etapa 1:** Setup auth module");
    expect(todoContent2).toContain("- [ ] **Etapa 2:** Integrate routes");

    // 3. Run "/runplan stage 2"
    const result2 = await processMenuCommand("/runplan stage 2", session, tmpWorkspace, provider);
    expect(result2.success).toBe(true);
    expect(result2.response).toContain("stage 2");
    expect(result2.autoExecute?.prompt).toContain("[RUNPLAN STAGE 2]");
    expect(result2.autoExecute?.prompt).toContain("router.ts");
    expect(result2.autoExecute?.prompt).not.toContain("auth.ts");

    // 4. Test Lifecycle - new session deletes the file
    await processMenuCommand("/session new", session, tmpWorkspace, provider);
    expect(readPlanTodoFile(tmpWorkspace)).toBeNull();
  });

  it("handles lifecycle of plan todo file on session load and clear", async () => {
    const planText = `
# Implementation Plan
### Stage 1: Fix bug
Modify [app.ts](file:///Users/lucas/www/rei/app.ts)
    `;

    const session: ChatSession = {
      mode: "planning",
      messages: [
        { role: "assistant", content: planText }
      ]
    };

    // Initialize todo file
    initPlanTodoFile(tmpWorkspace, planText);
    expect(readPlanTodoFile(tmpWorkspace)).not.toBeNull();

    // 1. Clear session deletes the file
    await processMenuCommand("/clear", session, tmpWorkspace, provider);
    expect(readPlanTodoFile(tmpWorkspace)).toBeNull();

    // Save session containing plan to mock session-store
    saveSession(tmpWorkspace, session.messages, session.mode, session.summary, "2026-05-26T20:59:58Z");
    
    // We loaded it via session load
    // Mock the session list entry and load
    const activeSessions = listSessions(tmpWorkspace);
    if (activeSessions.length > 0) {
      const sessionId = activeSessions[0].id;
      const loadRes = await processMenuCommand(`/session load ${sessionId}`, { mode: "planning", messages: [] }, tmpWorkspace, provider);
      expect(loadRes.success).toBe(true);
      // Recreates the todo file!
      expect(readPlanTodoFile(tmpWorkspace)).not.toBeNull();
      expect(readPlanTodoFile(tmpWorkspace)).toContain("Etapa 1: Fix bug");
    }
  });

  it("creates and parses stages from flexible plan formats (lists and bullets)", async () => {
    const flexiblePlanText = `
- [ ] **Etapa 1:** Limpiar app.html (eliminar datos corruptos/binarios)
  - [ ] **1. Subtarea** (this should not match)
1. **Etapa 2:** Verificar que DashboardComponent se renderice
  - [ ] **2. Subtarea** (this should not match)
- Stage 3: Verificar imports de Material
### 📦 Fase 4: Capa de Datos (Services + Mock)
- [ ] **5. Crear DollarService** (this should not match)
    `;

    initPlanTodoFile(tmpWorkspace, flexiblePlanText);
    const todoContent = readPlanTodoFile(tmpWorkspace);
    expect(todoContent).not.toBeNull();
    expect(todoContent).toContain("- [ ] **Etapa 1:** Limpiar app.html (eliminar datos corruptos/binarios)");
    expect(todoContent).toContain("- [ ] **Etapa 2:** Verificar que DashboardComponent se renderice");
    expect(todoContent).toContain("- [ ] **Etapa 3:** Verificar imports de Material");
    expect(todoContent).toContain("- [ ] **Etapa 4:** Capa de Datos (Services + Mock)");
    expect(todoContent).not.toContain("Subtarea");
    expect(todoContent).not.toContain("DollarService");
  });

  it("handles /saveplan and /loadplan commands", async () => {
    const planText = `
### 📦 Fase 1: Capa de Datos (Services + Mock)
We need to edit auth.ts.
- Modify [auth.ts](file:///Users/lucas/www/rei/auth.ts)
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
    expect(loadResult.response).toContain("Plan 'my-cool-plan' loaded successfully");
    expect(loadResult.newSession?.messages.length).toBe(1);
    expect(loadResult.newSession?.messages[0].content).toBe(planText);

    // Verify .rei/current-plan-todo.md was generated
    const todoContent = readPlanTodoFile(tmpWorkspace);
    expect(todoContent).not.toBeNull();
    expect(todoContent).toContain("- [ ] **Etapa 1:** Capa de Datos (Services + Mock)");

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
- Modify [Program.cs](file:///Users/lucas/www/rei/Program.cs)
- Modify [app.py](file:///Users/lucas/www/rei/app.py)
- Modify [main.rs](file:///Users/lucas/www/rei/main.rs)
- Modify [handler.go](file:///Users/lucas/www/rei/handler.go)
- Modify [index.php](file:///Users/lucas/www/rei/index.php)
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

