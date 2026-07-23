/**
 * The per-mode system directive prepended on the native function-calling path.
 *
 * REI's shared mode prompt is XML-centric ("emit an <edit> block per file"), which on the
 * function-calling path buries the batching guidance and nudges one-tool-call-per-response — each
 * response re-processes the whole growing conversation, so a multi-edit task balloons to N slow
 * round-trips. These directives steer the model toward efficient native tool use instead.
 */
import type { ChatMessage } from "../chat/types.js";
import type { SkillMode } from "../skills/skill-loader.js";

const AGENT_TOOLS_DIRECTIVE =
  "TOOL-CALLING EFFICIENCY (function-calling path — you use tools like edit_file / " +
  "read_files, NOT XML blocks): Apply ALL independent edits in ONE response by emitting " +
  "multiple edit_file tool calls together — never one edit per response when several are " +
  "already known. Read multiple files in a single read_files call (pass all paths at once). " +
  "Only split work across responses when a step genuinely depends on the OUTCOME of a " +
  "previous one (e.g. fixing a reported compile error). Every extra response re-processes the " +
  "entire conversation and is slow.\n" +
  "TO READ A REPO FILE, ALWAYS use read_files — it returns the WHOLE file and reflects your " +
  "pending edits. NEVER read file contents with run_command (cat/head/tail/sed/less): that " +
  "output is capped and the MIDDLE is dropped, so you only see the start and end and will think " +
  "the file is truncated. Use run_command only for real commands (build, tests, search like " +
  "grep/rg, git) — not for dumping a file you can read with read_files.\n" +
  "ALWAYS PREFER edit_file (small, targeted search/replace) for changes — it is cheap. Use " +
  "rewrite_file ONLY to restructure most of a file or after edit_file has repeatedly failed " +
  "to match. Rewriting an entire file just to change a few lines (e.g. an icon or a class) is " +
  "very slow and error-prone — do NOT do it.";

// ask/planning are READ-ONLY on the native path — no edit/create/rewrite tools exist for them, so
// the directive focuses on efficient investigation instead of edit batching.
const READONLY_TOOLS_DIRECTIVE =
  "TOOL-CALLING (function-calling path — you use tools like read_files / run_command, NOT XML " +
  "blocks).\n" +
  "RULE — EXECUTE, DON'T NARRATE (NON-NEGOTIABLE): The MOMENT you state you will look at, read, " +
  "check, search or inspect anything (\"leamos los archivos\", \"voy a leer\", \"primero reviso\", " +
  "\"let me read/check\"), you MUST emit the corresponding tool call IN THE SAME response. NEVER end " +
  "your turn with only a sentence describing what you are about to do — a turn that announces an " +
  "action without emitting its tool call accomplishes nothing and is a failure. If you intend to " +
  "read files to build the plan, call read_files NOW in this response; do not just say you will.\n" +
  "TO READ A REPO FILE, ALWAYS use read_files — it returns the WHOLE file. Pass ALL the " +
  "paths you need in a SINGLE read_files call. NEVER read file contents with run_command " +
  "(cat/head/tail/sed/less): that output is capped and the MIDDLE is dropped, so you only see the " +
  "start and end and will think the file is truncated. Use run_command only for real commands " +
  "(search like grep/rg, git, build/tests).\n" +
  "REPO VIEWS ARE PARTIAL: the skeleton map shows only files relevant to the query, and the file " +
  "tree may be grouped/truncated. They are NOT the complete repository. NEVER conclude a file " +
  "\"does not exist\" or ask the user whether it exists just because it isn't in what you were " +
  "shown — VERIFY it yourself with run_command (`ls <dir>`, `find . -name \"<pattern>\"`, " +
  "`git ls-files`) or read_files, then continue. Discover paths with tools; do not guess or ask.\n" +
  "You CANNOT edit files in this mode — investigate and " +
  "answer (or produce a plan); do not attempt to write changes.";

// Applies to every mode: when to ask the user vs. figure it out yourself. Reinforces the ask_user
// tool description and stays consistent with the read-only rule "discover paths with tools; do not
// guess or ask". See docs/intent-router-spec.md.
const ASK_USER_DIRECTIVE =
  "\nASK THE USER (ask_user tool) only when a decision is genuinely theirs, or a requirement is " +
  "truly ambiguous (e.g. which of two behaviours they want) — and ask BEFORE doing work that could " +
  "be wrong, rather than guessing and wasting turns. NEVER use ask_user for anything you can " +
  "determine yourself by reading files or running commands (paths, whether a file exists, code " +
  "facts): discover those with tools.";

/**
 * Prepends the mode-appropriate native-tools directive right after the leading system message(s)
 * so it lands at high priority. agent → edit-batching guidance; ask/planning → read-only
 * investigation guidance. Both get the shared ask_user guidance.
 */
export function withNativeToolsDirective(
  messages: ChatMessage[],
  mode: SkillMode = "agent",
): ChatMessage[] {
  const directive: ChatMessage = {
    role: "system",
    content:
      (mode === "agent" ? AGENT_TOOLS_DIRECTIVE : READONLY_TOOLS_DIRECTIVE) +
      ASK_USER_DIRECTIVE,
  };
  const firstNonSystem = messages.findIndex((m) => m.role !== "system");
  const at = firstNonSystem === -1 ? messages.length : firstNonSystem;
  return [...messages.slice(0, at), directive, ...messages.slice(at)];
}
