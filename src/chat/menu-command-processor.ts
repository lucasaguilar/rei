import * as fs from "node:fs";
import * as path from "node:path";
import type { ChatMessage, ChatSession, SessionMode } from "./types.js";
import { getHelpText } from "../cli/constants/chat.constants.js";
import {
  archiveCurrentSession,
  listSessions,
  loadSessionById,
  saveSession,
} from "./session-store.js";
import { compactSession } from "./compactor.js";
import { startIndexingWorker } from "../context/rag/rag-indexer.js";
import { generateRepoMap } from "../tools/repo-map-generator.js";
import type { ModelProvider } from "../providers/model-provider.js";
import { clearPromptCache } from "../prompts/loader.js";
import { buildFileMatcherRegex } from "../language/language-capabilities.js";
import {
  clearCurrentPlan,
  saveCurrentPlanContent,
  restoreCurrentPlanFromSession,
  savePlanToFile,
  loadPlanFromFile,
  loadCurrentPlanContent,
  STAGE_REGEX,
  isPlanMessage,
} from "./plan-tracker.js";
import {
  saveSpecToFile,
  loadSpecFromFile,
  isSpecMessage,
} from "./spec-tracker.js";

export interface CommandResult {
  success: boolean;
  response: string;
  newSession?: ChatSession;
  autoExecute?: { prompt: string };
  recordInSession?: boolean;
  recreateAgent?: boolean;
}

export async function processMenuCommand(
  command: string,
  session: ChatSession,
  workspacePath: string,
  provider: ModelProvider,
): Promise<CommandResult> {
  const trimmed = command.trim();

  if (trimmed === "/session") {
    const nonSystem = session.messages.filter((m) => m.role !== "system");
    const turns = Math.floor(nonSystem.length / 2);
    const created = session.createdAt
      ? new Date(session.createdAt).toLocaleString()
      : "not saved yet";

    return {
      success: true,
      response:
        `[REI] Current session\n` +
        `Mode: ${session.mode}\n` +
        `Turns: ${turns}\n` +
        `Created: ${created}\n` +
        `Summary: ${session.summary ? "yes" : "no"}`,
    };
  }

  const sessionNewMatch = trimmed.match(/^\/session\s+new(?:\s+(.+))?$/);
  if (sessionNewMatch) {
    const customName = sessionNewMatch[1]?.trim();
    const archivedName =
      session.messages.length > 0 ? archiveCurrentSession(workspacePath, customName) : null;
    const newSession: ChatSession = { messages: [], mode: session.mode };

    saveSession(workspacePath, newSession.messages, newSession.mode);
    clearCurrentPlan(workspacePath);

    return {
      success: true,
      response: archivedName
        ? `[REI] Archived current session as ${archivedName}. Started a new ${newSession.mode} session.`
        : `[REI] Started a new ${newSession.mode} session.`,
      newSession,
      recordInSession: false,
    };
  }

  const sessionArchiveMatch = trimmed.match(/^\/session\s+archive(?:\s+(.+))?$/);
  if (sessionArchiveMatch) {
    const customName = sessionArchiveMatch[1]?.trim();
    if (session.messages.length === 0) {
      return {
        success: false,
        response: "[REI] Current session is empty. Nothing to archive.",
      };
    }
    const archivedName = archiveCurrentSession(workspacePath, customName);
    const newSession: ChatSession = { messages: [], mode: session.mode };
    saveSession(workspacePath, newSession.messages, newSession.mode);
    clearCurrentPlan(workspacePath);

    return {
      success: true,
      response: archivedName
        ? `[REI] Archived current session as ${archivedName}. Started a new ${newSession.mode} session.`
        : `[REI] Failed to archive session.`,
      newSession,
      recordInSession: false,
    };
  }

  if (trimmed === "/session list") {
    const sessions = listSessions(workspacePath);
    if (sessions.length === 0) {
      return {
        success: true,
        response: "[REI] No archived sessions found.",
      };
    }

    const lines = sessions.slice(0, 20).map((entry) => {
      const updated = new Date(entry.updatedAt).toLocaleString();
      return `- ${entry.id} | ${entry.mode} | ${entry.turns} turns | updated ${updated}`;
    });

    return {
      success: true,
      response: `[REI] Archived sessions:\n${lines.join("\n")}`,
    };
  }

  const loadSessionMatch = trimmed.match(/^\/session\s+load\s+(\S+)$/);
  if (loadSessionMatch) {
    const id = loadSessionMatch[1];
    const loaded = loadSessionById(workspacePath, id);

    if (!loaded) {
      return {
        success: false,
        response: `[REI] Session not found: ${id}`,
      };
    }

    const currentHadContent = session.messages.length > 0;
    const archivedName = currentHadContent
      ? archiveCurrentSession(workspacePath)
      : null;

    saveSession(
      workspacePath,
      loaded.messages,
      loaded.mode,
      loaded.summary,
      loaded.createdAt,
    );
    restoreCurrentPlanFromSession(workspacePath, loaded.messages);

    return {
      success: true,
      response: archivedName
        ? `[REI] Archived current session as ${archivedName}. Loaded session ${id}.`
        : `[REI] Loaded session ${id}.`,
      newSession: {
        messages: loaded.messages,
        mode: loaded.mode,
        createdAt: loaded.createdAt,
        summary: loaded.summary,
      },
    };
  }

  if (trimmed === "/reloadprompts") {
    clearPromptCache();
    return {
      success: true,
      response:
        "[REI] Prompt cache cleared. All prompts will be reloaded from disk on next request.",
    };
  }
  if (trimmed === "/clear") {
    const newMessages: ChatMessage[] = [];
    saveSession(
      workspacePath,
      newMessages,
      session.mode,
      session.summary,
      session.createdAt,
    );
    clearCurrentPlan(workspacePath);
    return {
      success: true,
      response:
        "[REI] Conversation history has been cleared. Starting with a fresh context.",
      newSession: { ...session, messages: newMessages },
      recordInSession: false,
    };
  }

  if (trimmed === "/compact") {
    const nonSystem = session.messages.filter((m) => m.role !== "system");
    if (nonSystem.length < 2) {
      return {
        success: false,
        response: "[REI] Session is too short to compact (nothing to summarize).",
      };
    }

    const compactorModel = process.env.COMPACTOR_MODEL;

    // Warn if model name looks like OpenRouter format but provider is Ollama
    const providerName = (process.env.MODEL_PROVIDER ?? "").toLowerCase();
    const modelWarning =
      compactorModel && providerName === "ollama" && compactorModel.includes("/")
        ? `\n⚠️  COMPACTOR_MODEL="${compactorModel}" looks like OpenRouter format. ` +
          `For Ollama use the local name (e.g. qwen3:4b). ` +
          `Run \`ollama pull qwen3:4b\` and set COMPACTOR_MODEL=qwen3:4b.`
        : "";

    try {
      const beforeCount = nonSystem.length;
      const compactedMessages = await compactSession({
        messages: session.messages,
        provider,
        modelOverride: compactorModel,
        force: true, // manual /compact always bypasses the auto-threshold
      });
      const afterCount = compactedMessages.filter((m) => m.role !== "system").length;

      saveSession(
        workspacePath,
        compactedMessages,
        session.mode,
        session.summary,
        session.createdAt,
      );

      const modelLabel = compactorModel ? ` (model: ${compactorModel})` : "";
      return {
        success: true,
        response:
          `[REI] Session compacted${modelLabel}. ` +
          `${beforeCount} → ${afterCount} messages. ` +
          `Older turns were summarized to preserve context window.` +
          modelWarning,
        newSession: { ...session, messages: compactedMessages },
      };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const hint =
        compactorModel && errMsg.toLowerCase().includes("not found")
          ? `\nHint: model "${compactorModel}" was not found. ` +
            (providerName === "ollama"
              ? `Run \`ollama pull ${compactorModel}\` or fix COMPACTOR_MODEL in your .env.`
              : `Check COMPACTOR_MODEL in your .env.`)
          : "";
      return {
        success: false,
        response: `[REI] Error compacting session: ${errMsg}${hint}`,
      };
    }
  }

  if (trimmed.startsWith("/runplan")) {
    // Filter optional placeholder: [stage <num>]
    const normTrimmed = trimmed.replace(/\s+\[stage\s+<num>\]$/i, "");
    const runPlanMatch = normTrimmed.match(/^\/runplan(?:\s+(?:stage)\s+(\d+))?$/i);
    if (!runPlanMatch) {
      return {
        success: false,
        response: "[RUNPLAN] Invalid format. Use /runplan or /runplan stage <number>.",
      };
    }

    // SOURCE selection: prefer the latest plan produced in THIS session's
    // planning turns, falling back to the persisted file only when the session
    // has none (e.g. after /session, before /loadplan). This way a freshly
    // (re)generated plan runs immediately — no /saveplan+/loadplan dance and no
    // stale-plan footgun. We exclude `sourceMode === "agent"` so we never pick
    // up an agent execution response that happens to echo "## Stage N:" headers.
    const lastPlanMsg = [...session.messages]
      .reverse()
      .find(
        (m) =>
          m.role === "assistant" &&
          m.content &&
          m.sourceMode !== "agent" &&
          isPlanMessage(m.content),
      );
    const planContent = lastPlanMsg?.content ?? loadCurrentPlanContent(workspacePath);

    if (!planContent) {
      return {
        success: false,
        response: "[RUNPLAN] No plan was found in this session.",
      };
    }
    let targetContent = planContent;
    let stageTitle = "";

    const stageNumStr = runPlanMatch[1];
    const stageNum = stageNumStr ? parseInt(stageNumStr, 10) : null;

    // Persist the active plan as the SOURCE fallback (used cross-session when the
    // session has no in-memory plan). No progress checklist — the agent executes
    // holistically, so "done" is the code + verify, not a per-stage todo.
    saveCurrentPlanContent(workspacePath, planContent);

     if (stageNum !== null) {
      const lines = planContent.split("\n");

      let startIndex = -1;
      let headerLevel = 0;

      for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(STAGE_REGEX);
        if (m && parseInt(m[3], 10) === stageNum) {
          startIndex = i;
          headerLevel = (m[1] ?? m[2] ?? "").length;
          stageTitle = lines[i];
          break;
        }
      }

      if (startIndex === -1) {
        return {
          success: false,
          response: `[RUNPLAN] Stage ${stageNum} was not found in the plan.`,
        };
      }

      // Find the end index of the section
      let endIndex = lines.length;
      for (let i = startIndex + 1; i < lines.length; i++) {
        const line = lines[i];
        if (line.startsWith("#")) {
          const m = line.match(STAGE_REGEX);
          const headerMatch = line.match(/^#+/);
          const matchLen = headerMatch ? headerMatch[0].length : 0;
          // Terminate if another stage is found, or if a header of same/higher level is found
          if (m || matchLen <= headerLevel) {
            endIndex = i;
            break;
          }
        }
      }

      targetContent = lines.slice(startIndex, endIndex).join("\n");
    }

     const fileRegex = buildFileMatcherRegex();
    const files = Array.from(
      new Set(targetContent.match(fileRegex) || []),
    );

    if (files.length === 0) {
      // No target files — action-only stage (e.g. "run npm install")
      const planPrompt = stageNum
        ? `[RUNPLAN STAGE ${stageNum}] Execute Stage ${stageNum} of the implementation plan.\n\nSUB-PLAN:\n${targetContent}`
        : `Execute the following plan:\n\nPLAN:\n${planContent}`;

      const responseMsg = stageNum
        ? `[REI] Switching to AGENT mode to execute stage ${stageNum}. No target files detected (action-only stage).`
        : `[REI] Switching to AGENT mode to execute the entire plan. No target files detected.`;

      const newMode = "agent" as SessionMode;
      saveSession(
        workspacePath,
        session.messages,
        newMode,
        session.summary,
        session.createdAt,
      );

      return {
        success: true,
        response: responseMsg,
        newSession: { ...session, mode: newMode },
        autoExecute: { prompt: planPrompt },
      };
    }

    const planPrompt = stageNum
      ? `[RUNPLAN STAGE ${stageNum}] Execute Stage ${stageNum} of the implementation plan.\n\nSUB-PLAN:\n${targetContent}\n\nFILES TO MODIFY:\n${files.join(", ")}`
      : `Execute the following plan over these files:\n\nPLAN:\n${planContent}\n\nFILES:\n${files.join(", ")}`;

    const responseMsg = stageNum
      ? `[REI] Switching to AGENT mode to execute stage ${stageNum}. Target files: ${files.join(", ")}`
      : `[REI] Switching to AGENT mode to execute the entire plan. Target files: ${files.join(", ")}`;

    const newMode = "agent" as SessionMode;
    saveSession(
      workspacePath,
      session.messages,
      newMode,
      session.summary,
      session.createdAt,
    );

    return {
      success: true,
      response: responseMsg,
      newSession: { ...session, mode: newMode },
      autoExecute: { prompt: planPrompt },
    };
  }

  const modeMatch = trimmed.match(/^\/mode\s+(\S+)$/);
  if (modeMatch) {
    const requested = modeMatch[1];
    if (
      requested === "ask" ||
      requested === "planning" ||
      requested === "agent"
    ) {
      const previousMode = session.mode;
      const newMode = requested as SessionMode;
      let messages = [...session.messages];

      if (previousMode === "agent" && newMode !== "agent") {
        messages = messages.filter((m) => m.role === "system");
      }

      saveSession(
        workspacePath,
        messages,
        newMode,
        session.summary,
        session.createdAt,
      );

      const modeDescriptions: Record<SessionMode, string> = {
        ask: "Mode switched to ASK. I will answer questions based on the repository context without proposing changes.",
        planning:
          "Mode switched to PLANNING. I will help you design a technical plan for your changes.",
        agent:
          "Mode switched to AGENT. I am now authorized to execute tasks, modify files, and apply patches.",
      };

      return {
        success: true,
        response: `[REI] ${modeDescriptions[newMode]}`,
        newSession: { ...session, mode: newMode, messages },
      };
    }
    return {
      success: false,
      response: `Unknown mode: ${requested}. Available: ask, planning, agent`,
    };
  }

  if (trimmed === "/tdd") {
    if (process.env.REI_TDD_MODE === "true") {
      process.env.REI_TDD_MODE = "false";
      return {
        success: true,
        response: "[REI] TDD Mode deactivated. Sandbox will only check types.",
      };
    } else {
      process.env.REI_TDD_MODE = "true";
      return {
        success: true,
        response:
          "[REI] TDD Mode activated! Sandbox will now run 'npm run test' during edit validation.",
      };
    }
  }

  if (trimmed === "/index") {
    // 1. Generate and persist the AST Skeleton Map — show progress via console
    console.log("\n\x1b[33m[REI] Generando skeleton map AST...\x1b[0m");
    generateRepoMap(workspacePath)
      .then(() => {
        console.log("\x1b[32m[REI] ✓ Skeleton map AST generado correctamente.\x1b[0m\n");
      })
      .catch((err) =>
        console.error("[/index] Repo map error:", err),
      );

    // 2. Start the RAG vector indexing with progress feedback
    startIndexingWorker(workspacePath, {
      onProgress: (indexed, total) => {
        console.log(`\x1b[33m[REI] RAG indexing... ${indexed}/${total} archivos\x1b[0m`);
      },
      onDone: (message) => {
        console.log(`\x1b[32m[REI] ✓ ${message}\x1b[0m\n`);
      },
    });
    return {
      success: true,
      response:
        "[REI] Full repository indexing started. The AST skeleton map is updating and RAG indexing is running in the background.",
    };
  }

  // --- /provider command ---
  const providerMatch = trimmed.match(/^\/provider(?:\s+(agent))?(?:\s+(\S+))?$/i);
  if (providerMatch) {
    const isAgentTarget = !!providerMatch[1];
    const requested = providerMatch[2];
    const currentPrimary = (process.env.MODEL_PROVIDER || "mock").toLowerCase().trim();
    const currentAgent = (process.env.AGENT_MODEL_PROVIDER || "").toLowerCase().trim();

    if (!requested) {
      if (isAgentTarget) {
        return {
          success: true,
          response: currentAgent
            ? `[REI] Dedicated Agent provider: '${currentAgent}'\nUsage: '/provider agent <name>' to change it, or '/provider agent clear' to disable it.`
            : `[REI] Dedicated Agent provider is currently disabled (Agent mode falls back to primary provider: '${currentPrimary}').\nUsage: '/provider agent <name>' to enable it.`,
        };
      }
      const agentProv = currentAgent
        ? `\n[REI] Dedicated Agent provider: '${currentAgent}'`
        : "";
      return {
        success: true,
        response: `[REI] Active provider (Ask/Planning): '${currentPrimary}'${agentProv}\nAvailable: 'ollama', 'openrouter', 'gemini', 'groq', 'llmstudio', 'huggingface', 'mock'.\nUsage:\n  '/provider <name>' to change Ask/Planning provider.\n  '/provider agent <name>' to change Agent provider.`,
      };
    }

    const lower = requested.toLowerCase().trim();
    if (isAgentTarget && (lower === "none" || lower === "clear" || lower === "disable")) {
      process.env.AGENT_MODEL_PROVIDER = "";
      return {
        success: true,
        response: `[REI] Dedicated Agent provider disabled. Agent mode will now use primary provider: '${currentPrimary}'.`,
        recreateAgent: true,
      };
    }

    const VALID_PROVIDERS = ["mock", "ollama", "groq", "gemini", "openrouter", "huggingface", "llmstudio"];
    if (!VALID_PROVIDERS.includes(lower)) {
      return {
        success: false,
        response: `[REI] Unknown provider: '${requested}'. Expected one of: ${VALID_PROVIDERS.join(", ")}`,
      };
    }

    if (isAgentTarget) {
      process.env.AGENT_MODEL_PROVIDER = lower;
      return {
        success: true,
        response: `[REI] Dedicated Agent provider changed to: '${lower}'. Agent recreated successfully.`,
        recreateAgent: true,
      };
    } else {
      process.env.MODEL_PROVIDER = lower;
      return {
        success: true,
        response: `[REI] Active provider changed to: '${lower}'. Agent recreated successfully.`,
        recreateAgent: true,
      };
    }
  }

  // --- /model command ---
  const modelMatch = trimmed.match(/^\/model(?:\s+(agent))?(?:\s+(\S+))?$/i);
  if (modelMatch) {
    const isAgentTarget = !!modelMatch[1];
    const requested = modelMatch[2];
    const currentPrimaryProvider = (process.env.MODEL_PROVIDER || "ollama").toLowerCase().trim();
    const currentAgentProvider = (process.env.AGENT_MODEL_PROVIDER || "").toLowerCase().trim();
    const targetProvider = isAgentTarget
      ? (currentAgentProvider || currentPrimaryProvider)
      : currentPrimaryProvider;

    // Helper to get active model env var for current provider
    const getModelEnvVar = (providerName: string, mode?: string): string | undefined => {
      switch (providerName) {
        case "openrouter":
          return mode === "agent"
            ? (process.env.OPENROUTER_MODEL_AGENT ?? process.env.OPENROUTER_MODEL)
            : process.env.OPENROUTER_MODEL;
        case "ollama":
          return mode === "agent"
            ? (process.env.OLLAMA_MODEL_AGENT ?? process.env.OLLAMA_MODEL)
            : process.env.OLLAMA_MODEL;
        case "groq":
          return mode === "agent"
            ? (process.env.GROQ_MODEL_AGENT ?? process.env.GROQ_MODEL)
            : process.env.GROQ_MODEL;
        case "gemini":
          return mode === "agent"
            ? (process.env.GEMINI_MODEL_AGENT ?? process.env.GEMINI_MODEL)
            : process.env.GEMINI_MODEL;
        case "huggingface":
          return mode === "agent"
            ? (process.env.HF_MODEL_AGENT ?? process.env.HF_MODEL)
            : process.env.HF_MODEL;
        case "llmstudio":
          return mode === "agent"
            ? (process.env.LLM_STUDIO_MODEL_AGENT ?? process.env.LLM_STUDIO_MODEL)
            : process.env.LLM_STUDIO_MODEL;
        default:
          return undefined;
      }
    };

    const currentModel = getModelEnvVar(targetProvider, isAgentTarget ? "agent" : undefined) || "default";

    if (!requested) {
      if (isAgentTarget) {
        return {
          success: true,
          response: `[REI] Active model for Agent ('${targetProvider}'): '${currentModel}'\nUsage: '/model agent <model_name>' to change it.`,
        };
      }

      let availableModelsText = "";
      if (targetProvider === "ollama") {
        try {
          const baseUrl = (process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434").replace(/\/+$/, "");
          const res = await fetch(`${baseUrl}/api/tags`);
          if (res.ok) {
            const data = (await res.json()) as { models?: Array<{ name: string }> };
            if (data.models && data.models.length > 0) {
              const names = data.models.map((m) => m.name);
              availableModelsText = `\n\nAvailable models in Ollama:\n${names.map((n) => `  - ${n}`).join("\n")}`;
            }
          }
        } catch {
          availableModelsText = "\n\n(Note: Could not fetch available models. Make sure Ollama is running.)";
        }
      } else if (targetProvider === "llmstudio") {
        try {
          const baseUrl = (process.env.LLM_STUDIO_BASE_URL || "http://localhost:1234/v1").replace(/\/+$/, "");
          const res = await fetch(`${baseUrl}/models`);
          if (res.ok) {
            const data = (await res.json()) as { data?: Array<{ id: string }> };
            if (data.data && data.data.length > 0) {
              const names = data.data.map((m) => m.id);
              availableModelsText = `\n\nAvailable models in LM Studio:\n${names.map((n) => `  - ${n}`).join("\n")}`;
            }
          }
        } catch {
          availableModelsText = "\n\n(Note: Could not fetch available models. Make sure LM Studio API server is running.)";
        }
      }

      let agentModelText = "";
      if (currentAgentProvider) {
        const agentModel = getModelEnvVar(currentAgentProvider, "agent") || "default";
        agentModelText = `\n[REI] Dedicated Agent model ('${currentAgentProvider}'): '${agentModel}'`;
      }

      return {
        success: true,
        response: `[REI] Active model for Ask/Planning ('${currentPrimaryProvider}'): '${currentModel}'${agentModelText}${availableModelsText}\nUsage:\n  '/model <model_name>' to change Ask/Planning model.\n  '/model agent <model_name>' to change Agent model.`,
      };
    }

    // Update the environment variables for this provider
    switch (targetProvider) {
      case "ollama":
        if (isAgentTarget) {
          process.env.OLLAMA_MODEL_AGENT = requested;
        } else {
          process.env.OLLAMA_MODEL = requested;
          process.env.OLLAMA_MODEL_ASK = requested;
          process.env.OLLAMA_MODEL_PLANNING = requested;
        }
        break;
      case "openrouter":
        if (isAgentTarget) {
          process.env.OPENROUTER_MODEL_AGENT = requested;
        } else {
          process.env.OPENROUTER_MODEL = requested;
        }
        break;
      case "gemini":
        if (isAgentTarget) {
          process.env.GEMINI_MODEL_AGENT = requested;
        } else {
          process.env.GEMINI_MODEL = requested;
        }
        break;
      case "groq":
        if (isAgentTarget) {
          process.env.GROQ_MODEL_AGENT = requested;
        } else {
          process.env.GROQ_MODEL = requested;
        }
        break;
      case "huggingface":
        if (isAgentTarget) {
          process.env.HF_MODEL_AGENT = requested;
        } else {
          process.env.HF_MODEL = requested;
        }
        break;
      case "llmstudio":
        if (isAgentTarget) {
          process.env.LLM_STUDIO_MODEL_AGENT = requested;
        } else {
          process.env.LLM_STUDIO_MODEL = requested;
        }
        break;
      default:
        return {
          success: false,
          response: `[REI] Current provider '${targetProvider}' does not support dynamic model changes.`,
        };
    }

    const modeLabel = isAgentTarget ? "Agent" : "Ask/Planning";
    return {
      success: true,
      response: `[REI] ${modeLabel} model changed to: '${requested}' (provider: '${targetProvider}'). Agent recreated successfully.`,
      recreateAgent: true,
    };
  }

  if (trimmed.startsWith("/saveplan")) {
    const saveMatch = trimmed.match(/^\/saveplan\s+(\S+)$/i);
    if (!saveMatch) {
      return {
        success: false,
        response: "[REI] Invalid format. Use: /saveplan <name>",
      };
    }

    const planName = saveMatch[1];
    const lastPlanMsg = [...session.messages]
      .reverse()
      .find(
        (m) =>
          m.role === "assistant" &&
          m.content &&
          isPlanMessage(m.content),
      );

    if (!lastPlanMsg || !lastPlanMsg.content) {
      return {
        success: false,
        response: "[REI] No plan was found in this session to save.",
      };
    }

    try {
      const savedPath = savePlanToFile(workspacePath, planName, lastPlanMsg.content);
      return {
        success: true,
        response: `[REI] Full plan saved successfully to: ${savedPath}`,
      };
    } catch (err) {
      return {
        success: false,
        response: `[REI] Error saving plan: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  if (trimmed.startsWith("/loadplan")) {
    const loadMatch = trimmed.match(/^\/loadplan\s+(\S+)$/i);
    if (!loadMatch) {
      return {
        success: false,
        response: "[REI] Invalid format. Use: /loadplan <name>",
      };
    }

    const planName = loadMatch[1];
    try {
      const planContent = loadPlanFromFile(workspacePath, planName);
      
      // Ingest the loaded plan as a planning-mode assistant message so /runplan
      // picks it up as the SOURCE (latest planning plan in the session).
      const updatedMessages = [...session.messages, {
        role: "assistant" as const,
        content: planContent,
        sourceMode: "planning" as const,
      }];

      saveSession(
        workspacePath,
        updatedMessages,
        session.mode,
        session.summary,
        session.createdAt,
      );

      // Persist it as the cross-session SOURCE fallback too.
      saveCurrentPlanContent(workspacePath, planContent);

      return {
        success: true,
        response: `[REI] Plan '${planName}' loaded into the session. Run it with /runplan or /runplan stage <n>.`,
        newSession: { ...session, messages: updatedMessages },
      };
    } catch (err) {
      return {
        success: false,
        response: `[REI] Error loading plan: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  if (trimmed.startsWith("/savespec")) {
    const saveMatch = trimmed.match(/^\/savespec\s+(\S+)$/i);
    if (!saveMatch) {
      return {
        success: false,
        response: "[REI] Invalid format. Use: /savespec <name>",
      };
    }

    const specName = saveMatch[1];
    const lastSpecMsg = [...session.messages]
      .reverse()
      .find(
        (m) =>
          m.role === "assistant" && m.content && isSpecMessage(m.content),
      );

    if (!lastSpecMsg || !lastSpecMsg.content) {
      return {
        success: false,
        response:
          "[REI] No spec was found in this session to save. Use the write-spec skill first.",
      };
    }

    try {
      const savedPath = saveSpecToFile(
        workspacePath,
        specName,
        lastSpecMsg.content,
      );
      return {
        success: true,
        response: `[REI] Spec saved successfully to: ${savedPath}`,
      };
    } catch (err) {
      return {
        success: false,
        response: `[REI] Error saving spec: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  if (trimmed.startsWith("/loadspec")) {
    const loadMatch = trimmed.match(/^\/loadspec\s+(\S+)$/i);
    if (!loadMatch) {
      return {
        success: false,
        response: "[REI] Invalid format. Use: /loadspec <name>",
      };
    }

    const specName = loadMatch[1];
    try {
      const specContent = loadSpecFromFile(workspacePath, specName);

      // Ingest the spec as an assistant message so the next planning turn
      // (micro-task-decomposition) consumes it as the scope contract.
      const updatedMessages = [
        ...session.messages,
        { role: "assistant" as const, content: specContent },
      ];

      saveSession(
        workspacePath,
        updatedMessages,
        session.mode,
        session.summary,
        session.createdAt,
      );

      return {
        success: true,
        response: `[REI] Spec '${specName}' loaded into the session. Decompose it with the micro-task-decomposition skill.`,
        newSession: { ...session, messages: updatedMessages },
      };
    } catch (err) {
      return {
        success: false,
        response: `[REI] Error loading spec: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  if (trimmed === "/help") {
    return {
      success: true,
      response: `[REI] Available commands:\n${getHelpText()}`,
    };
  }

  if (trimmed === "/env") {
    const ollamaVars = Object.entries(process.env)
      .filter(([key]) => key.startsWith("OLLAMA"))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key}=${value ?? ""}`);

    if (ollamaVars.length === 0) {
      return {
        success: true,
        response: "[REI] No OLLAMA environment variables found.",
      };
    }

    return {
      success: true,
      response: `[REI] OLLAMA environment variables:\n${ollamaVars.join("\n")}`,
    };
  }

  return {
    success: false,
    response: `Unknown command: ${trimmed}`,
  };
}
