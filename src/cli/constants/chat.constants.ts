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
  /pending
  /confirm
  /confirm --dry-run
  /discard
  /exit

Ready.`;
};

export const HELP_TEXT = `Commands:
  /exit           - end the session
  /clear          - clear conversation history
  /help           - show this help
  /mode ask       - switch to ask mode
  /mode planning  - switch to planning mode
  /mode agent     - switch to agent mode
  /pending        - show currently queued validated patches
  /confirm        - apply queued patches
  /confirm --dry-run - validate/apply-check queued patches only
  /discard        - clear queued patches without applying`;

export const MODE_PROMPTS: Record<SessionMode, string> = {
  ask: "ask > ",
  planning: "plan > ",
  agent: "agent > ",
};

export const THINKING_TEXT: Record<TurnStatus, string> = {
  building_context: "Building context...",
  fetching_external_knowledge: "Searching official docs...",
  calling_model: "Calling model...",
  producing_response: "Producing response...",
  compacting_memory: "Compacting memory...",
};

export const SPINNER_FRAMES = ["|", "/", "-", "\\"];
export const SHORTCUT_HINT =
  "Shortcuts: Up/Down history (at bottom) | Ctrl+U/D scroll | / commands | @ files | Tab complete | Esc close | Ctrl+R search";
export const MOUSE_SCROLL_STEP = 3;

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
  { command: "/pending", description: "show queued patches" },
  { command: "/confirm", description: "apply queued patches" },
  {
    command: "/confirm --dry-run",
    description: "validate queued patches only",
  },
  { command: "/discard", description: "clear queued patches" },
  { command: "/index", description: "index workspace for semantic RAG search" },
  { command: "/session", description: "show session info" },
  { command: "/session list", description: "list archived sessions" },
  {
    command: "/session load",
    description: "load an archived session",
    requiresArgs: true,
  },
  { command: "/session new", description: "start a new session" },
  { command: "/compact", description: "manually compact conversation memory" },
];

// NOTE: Global regex to match and strip standard ANSI console escape sequences
export const ANSI_REGEX = /\x1B\[[0-?]*[ -/]*[@-~]/g;
