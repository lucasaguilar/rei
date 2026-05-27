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
import {
  deletePlanTodoFile,
  initPlanTodoFile,
  recreatePlanTodoFileFromSession,
} from "./plan-tracker.js";

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
    deletePlanTodoFile(workspacePath);

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
    deletePlanTodoFile(workspacePath);

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
    recreatePlanTodoFileFromSession(workspacePath, loaded.messages);

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
    deletePlanTodoFile(workspacePath);
    return {
      success: true,
      response:
        "[REI] Conversation history has been cleared. Starting with a fresh context.",
      newSession: { ...session, messages: newMessages },
      recordInSession: false,
    };
  }

  if (trimmed === "/compact") {
    try {
      const compactedMessages = await compactSession({
        messages: session.messages,
        provider: provider,
        modelOverride: process.env.COMPACTOR_MODEL,
      });
      saveSession(
        workspacePath,
        compactedMessages,
        session.mode,
        session.summary,
        session.createdAt,
      );
      return {
        success: true,
        response:
          "[REI] Session compacted successfully. Older messages were summarized to optimize memory while preserving key technical decisions.",
        newSession: { ...session, messages: compactedMessages },
      };
    } catch (err) {
      return {
        success: false,
        response: `Error compacting session: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  if (trimmed.startsWith("/runplan")) {
    const runPlanMatch = trimmed.match(/^\/runplan(?:\s+(?:stage|step|fase|etapa|paso)\s+(\d+))?$/i);
    if (!runPlanMatch) {
      return {
        success: false,
        response: "[RUNPLAN] Formato inválido. Usá /runplan o /runplan stage <número>.",
      };
    }

    const lastPlanMsg = [...session.messages]
      .reverse()
      .find(
        (m) =>
          m.role === "assistant" &&
          m.content &&
          m.content.toLowerCase().includes("plan"),
      );

    if (!lastPlanMsg || !lastPlanMsg.content) {
      return {
        success: false,
        response: "[RUNPLAN] No se encontró ningún plan en esta sesión.",
      };
    }

    const planContent = lastPlanMsg.content;
    let targetContent = planContent;
    let stageTitle = "";

    const stageNumStr = runPlanMatch[1];
    const stageNum = stageNumStr ? parseInt(stageNumStr, 10) : null;

    if (stageNum === null || stageNum === 1) {
      initPlanTodoFile(workspacePath, planContent);
    } else {
      const todoPath = path.join(workspacePath, ".rei/current-plan-todo.md");
      if (!fs.existsSync(todoPath)) {
        initPlanTodoFile(workspacePath, planContent);
      }
    }

    if (stageNum !== null) {
      const lines = planContent.split("\n");
      const stageRegex = /^(#+)\s*(?:(?:fase|etapa|paso|stage|step)\s+)?0*(\d+)\b(.*)$/i;

      let startIndex = -1;
      let headerLevel = 0;

      for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(stageRegex);
        if (m && parseInt(m[2], 10) === stageNum) {
          startIndex = i;
          headerLevel = m[1].length;
          stageTitle = lines[i];
          break;
        }
      }

      if (startIndex === -1) {
        return {
          success: false,
          response: `[RUNPLAN] No se encontró la etapa ${stageNum} en el plan.`,
        };
      }

      // Find the end index of the section
      let endIndex = lines.length;
      for (let i = startIndex + 1; i < lines.length; i++) {
        const line = lines[i];
        if (line.startsWith("#")) {
          const m = line.match(stageRegex);
          // Terminate if another stage is found, or if a header of same/higher level is found
          if (m || line.match(/^#+/)[0].length <= headerLevel) {
            endIndex = i;
            break;
          }
        }
      }

      targetContent = lines.slice(startIndex, endIndex).join("\n");
    }

    const fileRegex =
      /([\w\-/]+\.(ts|js|json|md|tsx|jsx|yml|yaml|css|scss|html|cjs|mjs))/gi;
    const files = Array.from(
      new Set(targetContent.match(fileRegex) || []),
    );

    if (files.length === 0) {
      return {
        success: false,
        response: stageNum
          ? `[RUNPLAN] No se detectaron archivos a modificar en la etapa ${stageNum}.`
          : "[RUNPLAN] No se detectaron archivos a modificar en el plan.",
      };
    }

    const planPrompt = stageNum
      ? `[RUNPLAN STAGE ${stageNum}] Ejecutá la Etapa ${stageNum} del plan de implementación.\n\nSUB-PLAN:\n${targetContent}\n\nARCHIVOS A MODIFICAR:\n${files.join(", ")}`
      : `Ejecutá el siguiente plan sobre estos archivos:\n\nPLAN:\n${planContent}\n\nARCHIVOS:\n${files.join(", ")}`;

    const responseMsg = stageNum
      ? `[REI] Cambiando a modo AGENT para ejecutar la etapa ${stageNum}. Archivos objetivo: ${files.join(", ")}`
      : `[REI] Cambiando a modo AGENT para ejecutar el plan completo. Archivos objetivo: ${files.join(", ")}`;

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
    // 1. Generate and persist the AST Skeleton Map (errors are logged, not swallowed)
    generateRepoMap(workspacePath).catch((err) =>
      console.error("[/index] Repo map error:", err),
    );

    // 2. Start the RAG vector indexing
    startIndexingWorker(workspacePath, {
      onDone: () => {},
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
