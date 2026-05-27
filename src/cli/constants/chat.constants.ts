import { TurnStatus } from "../../core/models/agent.types.js";
import { SessionMode } from "../../chat/types.js";
import { REI_LOGO } from "../rei-logo.js";

export const getWelcomeMessage = (mode: SessionMode): string => {
  return `${REI_LOGO}
REI — Repository-Aware AI Agent

Mode: ${mode}
Commands:
  /mode ask
  /mode planning
  /mode agent
  /exit

Ready.`;
};

export function getHelpText(): string {
  return (
    "Commands:\n" +
    COMMANDS.map(
      (cmd) =>
        `  ${cmd.command.padEnd(16)}- ${cmd.description}` +
        (cmd.requiresArgs ? " <args>" : ""),
    ).join("\n")
  );
}

export const MODE_PROMPTS: Record<SessionMode, string> = {
  ask: "🚀 ask » ",
  planning: "🎯 plan » ",
  agent: "🧠 agent » ",
};

export const THINKING_TEXT: Record<TurnStatus, string> = {
  building_context: "Building context...",
  fetching_external_knowledge: "Searching official docs...",
  calling_model: "Calling model...",
  producing_response: "Producing response...",
  compacting_memory: "Compacting memory...",
  indexing_repository: "Indexing repository (generating local embeddings)...",
};

export const SPINNER_FRAMES = ["|", "/", "-", "\\"];
export const SHORTCUT_HINT =
  "\x1b[90mShortcuts: Up/Down history | / commands | @ files | Tab complete | Esc close | Ctrl+R search\x1b[0m";

export const COMMANDS: Array<{
  command: string;
  description: string;
  requiresArgs?: boolean;
}> = [
  { command: "/exit", description: "end the session" },
  { command: "/clear", description: "clear conversation history" },
  { command: "/help", description: "show available commands" },
  { command: "/mode ask", description: "switch to ask mode" },
  { command: "/mode planning", description: "switch to planning mode" },
  { command: "/mode agent", description: "switch to agent mode" },
  { command: "/runplan [stage <num>]", description: "execute planning-mode plan (optionally by stage)" },
  { command: "/saveplan <name>", description: "save the full plan to disk as .rei/plans/<name>.md" },
  { command: "/loadplan <name>", description: "load a plan from disk and update active checklist" },
  { command: "/tdd", description: "toggle TDD mode (run tests in sandbox)" },
  { command: "/index", description: "regenerate repository skeleton map" },
  { command: "/session", description: "show current session info" },
  { command: "/session list", description: "list archived sessions" },
  { command: "/session archive [name]", description: "archive current session as <name>" },
  { command: "/session new [name]", description: "start new, archive current as <name>" },
  { command: "/session load <id>", description: "load an archived session by ID" },
  { command: "/compact", description: "manually compact conversation memory" },
  { command: "/provider", description: "show or switch the active LLM provider" },
  { command: "/model", description: "show or switch the active LLM model" },
];

// NOTE: Global regex to match and strip standard ANSI console escape sequences
export const ANSI_REGEX = /\x1B\[[0-?]*[ -/]*[@-~]/g;
