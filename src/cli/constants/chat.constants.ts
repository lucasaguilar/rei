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

/** What each phase is called on the status line. Lowercase and short: it sits under a wall of tool
 *  lines and should read as a state, not as an announcement. */
export const THINKING_TEXT: Record<TurnStatus, string> = {
  building_context: "reading the repo",
  fetching_external_knowledge: "searching the docs",
  calling_model: "thinking",
  producing_response: "writing",
  compacting_memory: "compacting memory",
  indexing_repository: "indexing the repo",
  checking_hardware: "checking hardware",
};

/** Braille dots: smooth at the 100ms tick and one column wide, unlike the |/-\\ cycle it replaces,
 *  which visibly jerked and changed the line's width on every frame. */
export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/**
 * The status line: a spinner, what REI is doing, and how long it has been doing it.
 *
 * The elapsed count is the point. A local model can think for thirty seconds with nothing on
 * screen, and a frozen label is indistinguishable from a hung process — the seconds ticking up are
 * what say "still working" rather than "stuck".
 */
export function formatStatusLine(
  frame: string,
  label: string,
  elapsedMs: number,
): string {
  const secs = Math.floor(elapsedMs / 1000);
  const elapsed =
    secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${String(secs % 60).padStart(2, "0")}s`;
  return `\x1b[36m${frame}\x1b[0m \x1b[2m${label}\x1b[0m \x1b[2m·\x1b[0m \x1b[2m${elapsed}\x1b[0m`;
}
export const SHORTCUT_HINT =
  "\x1b[90mShortcuts: Up/Down history | / commands | @ files | Tab complete | Esc clear/close | Ctrl+R search\x1b[0m";

/**
 * What tab-completion should actually type: the invocable part of an entry, without its usage hint.
 *
 * A COMMANDS entry doubles as its own help line — `/runplan [stage <num>]` — so inserting it verbatim
 * left the placeholder in the input for the user to delete by hand every time. Everything from the
 * first `[` or `<` is documentation, not something to type.
 *
 * Entries that take an argument get a trailing space so the cursor is ready for it; the rest are
 * inserted as-is and can be submitted straight away.
 */
export function commandInsertText(command: string): string {
  const invocable = command.replace(/\s+[[<].*$/, "").trim();
  return invocable === command.trim() ? invocable : `${invocable} `;
}

export const COMMANDS: Array<{
  command: string;
  description: string;
  requiresArgs?: boolean;
}> = [
  { command: "/exit", description: "end the session" },
  { command: "/clear", description: "clear conversation history" },
  { command: "/help", description: "show available commands" },
  { command: "/version", description: "show REI version" },
  { command: "/mode ask", description: "switch to ask mode" },
  { command: "/mode planning", description: "switch to planning mode" },
  { command: "/mode agent", description: "switch to agent mode" },
  { command: "/runplan [stage <num>]", description: "execute planning-mode plan (optionally by stage)" },
  { command: "/saveplan <name>", description: "save the full plan to disk as .rei/plans/<name>.md" },
  { command: "/savereview <name>", description: "save the auditor's review as .rei/plans/<name>.review.md" },
  { command: "/loadplan <name>", description: "load a plan from disk and update active checklist" },
  { command: "/spec <task>", description: "SDD step 1 — write the spec for a task (forces the write-spec recipe)" },
  { command: "/decompose", description: "SDD step 2 — turn the current spec into a traceable plan" },
  { command: "/active [clear]", description: "show the active spec/plan, or unset them (/active clear [spec|plan])" },
  { command: "/trace", description: "SDD check — cross the active spec's criteria against the plan's Satisfies: lines, both ways" },
  { command: "/verbose [on|off]", description: "show or hide full command output, diffs and the model's reasoning" },
  { command: "/savespec <name>", description: "save the write-spec spec to disk as .rei/specs/<name>.md" },
  { command: "/think [level]", description: "set the reasoning level for this session (none|minimal|low|medium|high|xhigh)" },
  { command: "/loadspec <name>", description: "load a spec from disk into the session for decomposition" },
  { command: "/ask-document [file] <question>", description: "grounded Q&A over a document (uses the active doc if no file given)" },
  { command: "/read-document <file> [pp.N-M]", description: "print a literal page-range slice of a large document" },
  { command: "/docs", description: "list workspace documents and show which is active" },
  { command: "/doc use <file>", description: "set the active document for /ask-document" },
  { command: "/doc clear", description: "deactivate the current document" },
  { command: "/tdd", description: "toggle TDD mode (run tests in sandbox)" },
  { command: "/index", description: "regenerate repository skeleton map" },
  { command: "/tree", description: "list session turns; /tree prune <n> excludes a detour from context, /tree keep <n> restores it" },
  { command: "/role", description: "activate a role posture (e.g. /role auditor); /role off to clear" },
  { command: "/roles", description: "list available roles (auditor, …)" },
  { command: "/mcp", description: "list MCP servers; /mcp on|off <name> to toggle one live (or all)" },
  { command: "/session", description: "show basic session info (use /session info for full details)" },
  { command: "/session info", description: "show full session info with token usage and repo summary" },
  { command: "/session list", description: "list archived sessions" },
  { command: "/session archive [name]", description: "archive current session as <name>" },
  { command: "/session new [name]", description: "start new, archive current as <name>" },
  { command: "/session load <id>", description: "load an archived session by ID" },
  { command: "/compact", description: "manually compact conversation memory" },
  { command: "/provider", description: "show or switch the active LLM provider" },
  { command: "/model", description: "show or switch the active LLM model" },
  { command: "/paste-image", description: "analyze an image from the clipboard (macOS/Windows/Linux)" },
];

// NOTE: Global regex to match and strip standard ANSI console escape sequences
export const ANSI_REGEX = /\x1B\[[0-?]*[ -/]*[@-~]/g;
