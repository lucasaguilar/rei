import type { ChatSession } from "../types.js";
import type { CommandHandler, CommandResult } from "./command-handler.js";
import { loadRole } from "../../skills/role-loader.js";

const PROVIDER_RE = /^\/provider(?:\s+(agent))?(?:\s+(\S+))?$/i;
const MODEL_RE = /^\/model(?:\s+(agent))?(?:\s+(\S+))?$/i;

const VALID_PROVIDERS = [
  "mock",
  "ollama",
  "groq",
  "gemini",
  "openrouter",
  "huggingface",
  "llmstudio",
  "mtplx",
  "omlx",
  "openai-compat",
];

/** Active model env var for a provider/mode (ask vs agent). */
function getModelEnvVar(providerName: string, mode?: string): string | undefined {
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
    case "mtplx":
      return mode === "agent"
        ? (process.env.MTPLX_MODEL_AGENT ?? process.env.MTPLX_MODEL)
        : process.env.MTPLX_MODEL;
    default:
      return undefined;
  }
}

/**
 * `/provider [agent] [name]` and `/model [agent] [name]` — view/switch the active provider and
 * model (per mode), setting the env vars and recreating the agent.
 * Extracted verbatim from menu-command-processor (Phase 1 — no behavior change).
 */
/**
 * A manual `/model` choice names a model of the provider that was active when you typed it, so
 * switching THAT slot's provider makes it unreachable — Ollama has no "mlx-community/…". Dropping
 * it hands the slot back to the new provider's configured model; keeping it asked the new backend
 * for the old backend's model and froze the status bar on a name that no longer existed.
 *
 * Only the slot that changed: `/provider agent x` leaves an ask/planning choice alone.
 */
function clearManualModelFor(
  slot: "agent" | "base",
  session: ChatSession | undefined,
): { newSession: ChatSession } | Record<string, never> {
  if (!session || session.manualModelScope !== slot) return {};
  return { newSession: { ...session, manualModel: undefined, manualModelScope: undefined } };
}

export const providerCommands: CommandHandler = {
  match: (c) => PROVIDER_RE.test(c) || MODEL_RE.test(c),

  run: async ({ command: trimmed, session, workspacePath }): Promise<CommandResult> => {
    const providerMatch = trimmed.match(PROVIDER_RE);
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
          response: `[REI] Active provider (Ask/Planning): '${currentPrimary}'${agentProv}\nAvailable: 'ollama', 'openrouter', 'gemini', 'groq', 'llmstudio', 'mtplx', 'huggingface', 'mock'.\nUsage:\n  '/provider <name>' to change Ask/Planning provider.\n  '/provider agent <name>' to change Agent provider.`,
        };
      }

      const lower = requested.toLowerCase().trim();
      if (isAgentTarget && (lower === "none" || lower === "clear" || lower === "disable")) {
        process.env.AGENT_MODEL_PROVIDER = "";
        return {
          success: true,
          response: `[REI] Dedicated Agent provider disabled. Agent mode will now use primary provider: '${currentPrimary}'.`,
          recreateAgent: true,
          ...clearManualModelFor("agent", session),
        };
      }

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
          ...clearManualModelFor("agent", session),
        };
      }
      process.env.MODEL_PROVIDER = lower;
      return {
        success: true,
        response: `[REI] Active provider changed to: '${lower}'. Agent recreated successfully.`,
        recreateAgent: true,
        ...clearManualModelFor("base", session),
      };
    }

    const modelMatch = trimmed.match(MODEL_RE);
    if (modelMatch) {
      const isAgentTarget = !!modelMatch[1];
      const requested = modelMatch[2];
      const currentPrimaryProvider = (process.env.MODEL_PROVIDER || "ollama").toLowerCase().trim();
      const currentAgentProvider = (process.env.AGENT_MODEL_PROVIDER || "").toLowerCase().trim();
      const targetProvider = isAgentTarget
        ? currentAgentProvider || currentPrimaryProvider
        : currentPrimaryProvider;

      const currentModel =
        getModelEnvVar(targetProvider, isAgentTarget ? "agent" : undefined) || "default";

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
        } else if (targetProvider === "mtplx") {
          try {
            const baseUrl = (process.env.MTPLX_BASE_URL || "http://localhost:8000/v1").replace(/\/+$/, "");
            const res = await fetch(`${baseUrl}/models`);
            if (res.ok) {
              const data = (await res.json()) as { data?: Array<{ id: string }> };
              if (data.data && data.data.length > 0) {
                const names = data.data.map((m) => m.id);
                availableModelsText = `\n\nAvailable models in MTPLX:\n${names.map((n) => `  - ${n}`).join("\n")}`;
              }
            }
          } catch {
            availableModelsText = "\n\n(Note: Could not fetch available models. Make sure MTPLX server is running.)";
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

      // Update the environment variables for this provider.
      switch (targetProvider) {
        case "ollama":
          if (isAgentTarget) process.env.OLLAMA_MODEL_AGENT = requested;
          else process.env.OLLAMA_MODEL = requested;
          break;
        case "openrouter":
          if (isAgentTarget) process.env.OPENROUTER_MODEL_AGENT = requested;
          else process.env.OPENROUTER_MODEL = requested;
          break;
        case "gemini":
          if (isAgentTarget) process.env.GEMINI_MODEL_AGENT = requested;
          else process.env.GEMINI_MODEL = requested;
          break;
        case "groq":
          if (isAgentTarget) process.env.GROQ_MODEL_AGENT = requested;
          else process.env.GROQ_MODEL = requested;
          break;
        case "huggingface":
          if (isAgentTarget) process.env.HF_MODEL_AGENT = requested;
          else process.env.HF_MODEL = requested;
          break;
        case "llmstudio":
          if (isAgentTarget) process.env.LLM_STUDIO_MODEL_AGENT = requested;
          else process.env.LLM_STUDIO_MODEL = requested;
          break;
        default:
          return {
            success: false,
            response: `[REI] Current provider '${targetProvider}' does not support dynamic model changes.`,
          };
      }

      const modeLabel = isAgentTarget ? "Agent" : "Ask/Planning";

      // Setting the model by hand outranks an active role's `preferredModel` — the most recent
      // explicit choice wins. Recorded on the SESSION rather than left to the env var, because the
      // role is consulted first and would otherwise keep shadowing what you just typed: `/model`
      // used to report success and change nothing at all while a role was active.
      //
      // Only when it targets the mode you are IN. `/model agent x` from ask mode configures agent
      // for later; it is not a statement about the turn you are about to run.
      const targetsThisMode = isAgentTarget === (session?.mode === "agent");
      const activeRole = session?.activeRole
        ? loadRole(session.activeRole, workspacePath)
        : null;
      const overriding =
        targetsThisMode && activeRole?.preferredModel && activeRole.preferredModel !== requested
          ? ` Overriding role '${activeRole.name}' (${activeRole.preferredModel}) for this session` +
            ` — /role ${activeRole.name} to go back.`
          : "";

      return {
        success: true,
        response: `[REI] ${modeLabel} model changed to: '${requested}' (provider: '${targetProvider}').${overriding}`,
        recreateAgent: true,
        ...(targetsThisMode && session
          ? {
              newSession: {
                ...session,
                manualModel: requested,
                // Which slot it was chosen for, so leaving this mode drops it instead of
                // carrying it over (ChatSession.manualModelScope).
                manualModelScope: (isAgentTarget ? "agent" : "base") as "agent" | "base",
              },
            }
          : {}),
      };
    }

    // Unreachable: match() guarantees one of the branches above handled it.
    return { success: false, response: "[REI] Unknown provider/model command." };
  },
};
