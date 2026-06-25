/**
 * Agent mode generator using structured function/tool calling.
 * Used when the active provider implements completeChatWithTools.
 * Falls back to the XML-based generator if not.
 */
import * as fs from "fs/promises";
import * as path from "path";
import type { ChatMessage } from "../chat/types.js";
import type { ModelProvider } from "../providers/model-provider.js";
import type { AgentLogger } from "../core/logger.js";
import type { AgentSREdit } from "../contracts/agent-interaction.types.js";
import type { McpRegistry } from "../tools/mcp/mcp-registry.js";
import {
  AGENT_TOOLS,
  WEB_SEARCH_TOOL,
  WEATHER_TOOL,
  mcpToolsToDefinitions,
} from "../contracts/tool-definitions.js";
import {
  executeCommand,
  limitCommandOutput,
} from "../tools/command-executor.js";
import { searchWeb } from "../tools/search-tool.js";
import { getWeather, formatWeatherOutput } from "../tools/weather-tool.js";
import { applyFileEdits } from "../tools/search-replace.js";
import { startStepSpan, startToolSpan } from "../telemetry/spans.js";
import {
  searchMcpTools,
  SEARCH_TOOLS_DEF,
  MAX_UNFILTERED,
  PRELOAD_K,
  SEARCH_K,
} from "../tools/tool-retriever.js";
import { getMaxTurns } from "../config/model-runtime.js";
import {
  loadSkills,
  buildUseSkillTool,
  findSkill,
  skillsForMode,
} from "../skills/skill-loader.js";
import {
  resolveWorkspacePath,
  toWorkspaceRelative,
  isWithinWorkspace,
} from "../workspace/file-security.js";
import {
  buildFileContextMessage,
  finalizeOutcome,
  validateProposedPatches,
  CREATED_FILES_MARKER,
  type ExecutionResult,
} from "./helpers/patch-helpers.js";

const MAX_TURNS = getMaxTurns();
const MAX_TRUNCATION_CONTINUATIONS = 3;
const TRUNCATION_CONTINUATION =
  "Your previous response was cut off by the output token limit. " +
  "Continue EXACTLY from where you left off — do NOT repeat, summarize, or restart. " +
  "Just continue the text as one uninterrupted response.";

/** Last user message text — fallback query for tool-RAG when userQuery isn't passed. */
function lastUserText(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") return messages[i].content;
  }
  return "";
}

/**
 * Detects when the model TRIED to call a tool but emitted it as text/XML instead
 * of using the native function-calling interface (e.g. `<read_files>`, `<edit_file>`,
 * or the legacy XML-path tags). Without this, such a turn is silently treated as a
 * plain-text final answer and nothing happens.
 */
function looksLikeAttemptedToolCall(content: string): boolean {
  if (!content) return false;
  // Native tool names emitted as XML-ish tags, the legacy XML action tags, or the
  // tell-tale `<parameter=` shape models use when faking function calls as text.
  return (
    /<\s*(read_files|edit_file|create_file|run_command|edit|create|wholefile|request_files|execute_command|call_tool)\b/i.test(
      content,
    ) || /<parameter\s*=/i.test(content)
  );
}

interface EditTask {
  callId: string;
  edit: AgentSREdit;
  // rewrite_file: `edit.replace` is the authoritative full content (no search matching).
  wholeFile?: boolean;
}

// Beyond this size we don't inline a file's updated content back to the model (avoids
// bloating the tool result); the model can re-read it if it truly needs the exact state.
const MAX_INLINE_EDIT_RESULT_CHARS = 24000;

/**
 * After a successful apply, build each edit's tool result INCLUDING the file's updated
 * content, so the model can compose further edits without re-reading it. This kills the
 * read-after-edit churn (edit → read same file → edit → read again …) that multiplies
 * model calls and dominates agent-turn latency. `alreadyProvided` is refreshed so that if
 * the model re-reads anyway, the read dedup short-circuits to "unchanged since shown".
 * Each file's content is inlined once per batch; oversized files are confirmed but not inlined.
 */
export function setEditResults(
  editTasks: EditTask[],
  candidate: Map<string, string>,
  toolResultsMap: Map<string, string>,
  alreadyProvided: Map<string, string>,
): void {
  const inlined = new Set<string>();
  for (const task of editTasks) {
    const f = task.edit.file;
    const updated = candidate.get(f) ?? "";
    if (inlined.has(f)) {
      toolResultsMap.set(
        task.callId,
        `OK: another edit to ${f} applied (its updated content is shown above — do not re-read it).`,
      );
      continue;
    }
    inlined.add(f);
    if (updated.length <= MAX_INLINE_EDIT_RESULT_CHARS) {
      // The model now has the post-edit content → a re-read is deduped to "reuse what you saw".
      alreadyProvided.set(f, updated);
      toolResultsMap.set(
        task.callId,
        `OK: edit to ${f} applied. The file now contains exactly:\n\`\`\`\n${updated}\n\`\`\`\n` +
          `You already have ${f}'s current content above — do NOT call read_files on it again; ` +
          `compose any further edits against this content. Apply MULTIPLE edits at once by emitting ` +
          `several edit_file calls in ONE response (don't do one per turn). When ALL changes for the ` +
          `task are done, reply with a brief summary (no tool call).`,
      );
    } else {
      // Too large to inline; do NOT refresh alreadyProvided (model hasn't seen the new state).
      toolResultsMap.set(
        task.callId,
        `OK: edit to ${f} applied to disk. (File is large — not inlined.) Avoid re-reading it ` +
          `unless you genuinely need its exact current state for another edit. When done, reply ` +
          `with a brief summary (no tool call).`,
      );
    }
  }
}

/**
 * Prepends a focused native-tools directive. REI's shared mode prompt is XML-centric
 * ("emit an <edit> block per file"), which on the function-calling path buries the batching
 * guidance and nudges one-tool-call-per-response — each response re-processes the whole
 * growing conversation, so a multi-edit task balloons to N slow round-trips. Empirically the
 * model DOES emit several edit_file calls in one response when told this directly (verified
 * via curl). Placed right after the leading system message(s) so it's high-priority.
 */
export function withNativeToolsDirective(messages: ChatMessage[]): ChatMessage[] {
  const directive: ChatMessage = {
    role: "system",
    content:
      "TOOL-CALLING EFFICIENCY (function-calling path — you use tools like edit_file / " +
      "read_files, NOT XML blocks): Apply ALL independent edits in ONE response by emitting " +
      "multiple edit_file tool calls together — never one edit per response when several are " +
      "already known. Read multiple files in a single read_files call (pass all paths at once). " +
      "Only split work across responses when a step genuinely depends on the OUTCOME of a " +
      "previous one (e.g. fixing a reported compile error). Every extra response re-processes the " +
      "entire conversation and is slow.\n" +
      "ALWAYS PREFER edit_file (small, targeted search/replace) for changes — it is cheap. Use " +
      "rewrite_file ONLY to restructure most of a file or after edit_file has repeatedly failed " +
      "to match. Rewriting an entire file just to change a few lines (e.g. an icon or a class) is " +
      "very slow and error-prone — do NOT do it.",
  };
  const firstNonSystem = messages.findIndex((m) => m.role !== "system");
  const at = firstNonSystem === -1 ? messages.length : firstNonSystem;
  return [...messages.slice(0, at), directive, ...messages.slice(at)];
}

/**
 * Executes an agent turn using native function/tool calling instead of XML parsing.
 * Returns the same ExecutionResult shape as the XML generator so callers are interchangeable.
 */
export async function executeAgentTurnWithTools(params: {
  provider: ModelProvider;
  messagesForModel: ChatMessage[];
  workspacePath: string;
  logger: AgentLogger;
  modelOverride?: string;
  /** Per-mode reasoning budget ("none" disables thinking). Forwarded to the provider. */
  reasoningEffort?: string;
  /** Connected MCP registry. When provided, MCP tools are merged into the tool list. */
  mcpRegistry?: McpRegistry;
  /** Live progress callback — emits "status" chunks as each tool runs so the
   *  user sees activity (this path is otherwise silent until the turn ends). */
  onChunk?: (event: {
    type: "thinking" | "text" | "status";
    content: string;
  }) => void;
  /** Raw user request, used by tool-RAG to select only relevant MCP tools. */
  userQuery?: string;
}): Promise<ExecutionResult> {
  const {
    provider,
    messagesForModel,
    workspacePath,
    logger,
    modelOverride,
    reasoningEffort,
    mcpRegistry,
    onChunk,
    userQuery,
  } = params;

  if (!provider.completeChatWithTools) {
    throw new Error(
      "executeAgentTurnWithTools: provider does not support completeChatWithTools",
    );
  }

  // Emits a one-line live status for a tool action (shown immediately by the CLI).
  const emitStatus = (msg: string) =>
    onChunk?.({ type: "status", content: `\n\x1b[33m${msg}\x1b[0m\n` });

  // Tool selection: with large MCP servers (e.g. Google Workspace ~60-90 tools)
  // sending every schema overflows local context. When there are many tools, expose
  // only a best-effort pre-load + a `search_tools` meta-tool, and let the model load
  // more on demand (model-driven, no embeddings). Small sets are sent in full.
  const allMcpTools = mcpRegistry ? mcpRegistry.getAvailableTools() : [];
  const query = userQuery ?? lastUserText(messagesForModel);
  const useToolSearch =
    allMcpTools.length > MAX_UNFILTERED && process.env.REI_TOOL_RAG !== "false";

  // Names of MCP tools currently exposed to the model (grows as it searches).
  const activeMcp = new Set<string>(
    useToolSearch
      ? searchMcpTools(query, allMcpTools, PRELOAD_K).map((t) => t.name)
      : allMcpTools.map((t) => t.name),
  );
  if (useToolSearch) {
    logger.logInfo("[tools] tool-search mode", {
      total: allMcpTools.length,
      preloaded: [...activeMcp],
    });
  }

  // Skills: reusable task recipes loaded on demand. Only the catalog (name +
  // description) rides in the `use_skill` tool; the full body is injected only
  // when the model invokes it — so many skills cost almost no context.
  const skills = skillsForMode(loadSkills(workspacePath), "agent");
  const useSkillTool = buildUseSkillTool(skills);

  // The tools array is rebuilt each turn so newly-searched tools become callable.
  const buildTools = () => {
    const mcp = mcpToolsToDefinitions(
      allMcpTools.filter((t) => activeMcp.has(t.name)),
    );
    // Expose the built-in web_search + weather tools on the native path too. They live
    // in UTILITY_TOOLS (ask/planning) but the native agent array previously only had
    // AGENT_TOOLS + MCP, so a "search the web" request had no REI tool to call and the
    // model would grab a Google MCP or do nothing. This is explicit-trigger only.
    const tools = [...AGENT_TOOLS, WEB_SEARCH_TOOL, WEATHER_TOOL, ...mcp];
    if (useToolSearch) tools.push(SEARCH_TOOLS_DEF);
    if (useSkillTool) tools.push(useSkillTool);
    return tools;
  };

  let currentMessages: ChatMessage[] = withNativeToolsDirective([
    ...messagesForModel,
  ]);
  let loopCount = 0;
  let firstTurnExplanation = "";
  // Caps the number of format-correction nudges when the model emits a tool call
  // as text/XML instead of via the native function-calling interface.
  let formatCorrections = 0;
  const MAX_FORMAT_CORRECTIONS = 2;
  // Caps how many times we bounce a failing FINAL verify back to the model for
  // self-correction before giving up (and applying with a not-verified warning).
  let verifyRetries = 0;
  const MAX_VERIFY_RETRIES = 2;
  // Caps how many times a turn that truncated mid-output (hit the output-token cap before
  // emitting a tool call — common with thinking models) is continued back into the loop.
  let truncationContinuations = 0;
  // Tracks consecutive search-block mismatches (edit_file whose <search> text is
  // not found verbatim in the file). Two-tier escalation, since a weak local model
  // often can't reproduce exact search text even with the file in front of it:
  //   - at 2: inject the file's exact content so it can copy the search verbatim.
  //   - at 4: it STILL can't match → tell it to stop using edit_file and call
  //           rewrite_file (whole-file overwrite), which has no match requirement.
  // The streak only resets on a successful edit.
  let consecutiveSearchMismatchFailures = 0;
  const MISMATCH_INJECT_AT = 2;
  const MISMATCH_WHOLEFILE_AT = 4;
  // Files created via create_file across the loop — surfaced to the user, since
  // the native tool path otherwise only reports creation back to the model.
  const createdFiles: string[] = [];

  const appendCreatedSummary = (resp: string): string => {
    if (createdFiles.length === 0) return resp;
    const unique = [...new Set(createdFiles)];
    return (
      resp +
      `${CREATED_FILES_MARKER}${unique.length} file(s) created:[0m\n` +
      unique.map((f) => `- ${f}`).join("\n")
    );
  };

  // Virtual working tree: file (workspace-relative) → its CURRENT edited content. Edits
  // accumulate here across turns WITHOUT touching disk; we validate the whole tree on every
  // edit and write it to disk only at the end. This lets interdependent files (e.g. an Angular
  // component's .ts and its .html template) be validated TOGETHER, instead of validating each
  // turn's edits one-against-disk — which made cross-file edits split across turns impossible
  // to satisfy and sent the model into edit loops.
  const virtualFiles = new Map<string, string>();
  const diskCache = new Map<string, string>();
  // Files already shown to the model (path → exact content shown). Lets read_files skip
  // re-dumping a file whose content hasn't changed since — it's still in the conversation
  // history, so re-reading just burns tokens/turns (a common model habit).
  const alreadyProvided = new Map<string, string>();
  // Normalize a model-supplied path to a canonical workspace-relative key. Accepts both
  // relative ("django/forms.py") and absolute in-workspace ("/testbed/django/forms.py") forms —
  // the latter is common when the workspace itself is an absolute path (e.g. SWE-bench's
  // /testbed root) and would otherwise be mangled into a phantom nested path. Used as the key
  // for the virtual tree / dedup so absolute and relative refs to the same file collapse.
  const toRel = (raw: string): string => toWorkspaceRelative(raw, workspacePath);
  // Same normalization, but enforces workspace containment — throws (→ ERROR tool result) for a
  // missing arg or a path that escapes the working directory. Used for writes.
  const resolveTarget = (raw: unknown): string => {
    if (!raw || typeof raw !== "string") {
      throw new Error("Missing required 'file' argument.");
    }
    const abs = resolveWorkspacePath(raw, workspacePath);
    if (!isWithinWorkspace(abs, workspacePath)) {
      throw new Error(
        `Path "${raw}" is outside the working directory. Use a path inside it.`,
      );
    }
    return toWorkspaceRelative(raw, workspacePath);
  };
  // Disk is never mutated during the loop, so the original content is stable to cache.
  const readDisk = async (file: string): Promise<string> => {
    if (!diskCache.has(file)) {
      diskCache.set(
        file,
        await fs
          .readFile(resolveWorkspacePath(file, workspacePath), "utf-8")
          .catch(() => ""),
      );
    }
    return diskCache.get(file)!;
  };
  // What the model is actually editing/should see: its own pending content if any, else disk.
  const currentContent = async (file: string): Promise<string> =>
    virtualFiles.has(file) ? virtualFiles.get(file)! : await readDisk(file);
  // Express the virtual tree as whole-file rewrites from disk (search = exact disk content, so
  // the sandbox apply NEVER mismatches; replace = accumulated content). Used for both the
  // cumulative validation and the final apply that the caller writes to disk.
  const virtualEdits = async (): Promise<AgentSREdit[]> => {
    const out: AgentSREdit[] = [];
    for (const [file, content] of virtualFiles) {
      out.push({ file, search: await readDisk(file), replace: content });
    }
    return out;
  };
  // Write the given files' current virtual content to disk.
  const persistToDisk = async (files: string[]): Promise<void> => {
    for (const f of files) {
      const abs = resolveWorkspacePath(f, workspacePath);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, virtualFiles.get(f)!, "utf-8");
    }
  };

  // Edit mode. DEFAULT = `direct`: work like a human/CLI agent — apply edits straight to disk
  // with NO per-edit sandbox compile-check; the model self-verifies via run_command (sees real
  // disk) and REI runs ONE final verify at the end. Lighter (no per-edit sandbox copies) and
  // avoids the reject-per-edit loop that saturates local models, at the cost of leaving partial
  // edits on disk if the task aborts (recoverable via git).
  // Opt into the stricter `REI_EDIT_MODE=sandbox` to validate the cumulative virtual tree per
  // edit and persist only green state (never leaves broken code on disk; heavier).
  const directMode = process.env.REI_EDIT_MODE !== "sandbox";

  while (loopCount < MAX_TURNS) {
    loopCount++;

    // One `step-N` span per loop iteration (IP-3, agent function-calling). Global-active so
    // the llm-call / tool spans created while this iteration runs nest under it.
    const endStep = startStepSpan(loopCount - 1);
    try {
      logger.logInfo(`[tools] Turn ${loopCount}/${MAX_TURNS}`);

      // Observability for preserve-thinking: only log when it's actually ON and
      // re-feeding reasoning — otherwise it's just noise (default is OFF).
      if (process.env.REI_PRESERVE_THINKING === "true") {
        const reasoningCarried = currentMessages.filter(
          (m) => m.role === "assistant" && m.reasoning_content,
        );
        logger.logInfo("[tools] preserve-thinking", {
          enabled: true,
          assistantMsgsWithReasoning: reasoningCarried.length,
          reasoningCharsResent: reasoningCarried.reduce(
            (n, m) => n + (m.reasoning_content?.length ?? 0),
            0,
          ),
        });
      }

      const result = await provider.completeChatWithTools(
        currentMessages,
        buildTools(),
        { model: modelOverride, reasoningEffort },
      );

      logger.logInfo("[tools] Response", {
        finishReason: result.finishReason,
        toolCalls: result.toolCalls.map((tc) => tc.function.name),
        contentPreview: result.content.slice(0, 120),
        reasoningPreview: result.reasoning?.slice(0, 120),
      });

      // Surface the model's reasoning live. In tool-calling turns, qwen3.6 puts its
      // narration in `reasoning` while `content` is empty — without this it's invisible.
      if (result.reasoning?.trim()) {
        onChunk?.({
          type: "thinking",
          content: result.reasoning.trim() + "\n",
        });
      }

      // Truncated mid-output with no tool call yet — hit the output-token cap before acting.
      // Common with thinking models that spend the budget on <think> reasoning. Instead of
      // accumulating text and ending the turn with ZERO edits (the old behavior, which made the
      // model "talk and never act"), preserve the partial output, nudge it to continue, and
      // RE-ENTER the loop so the continuation's TOOL CALLS get processed normally. Bounded by a
      // per-turn counter so a model that keeps truncating can't spin forever.
      if (result.finishReason === "length" && result.toolCalls.length === 0) {
        if (truncationContinuations < MAX_TRUNCATION_CONTINUATIONS) {
          truncationContinuations++;
          logger.logInfo(
            `[truncation] response cut off (${truncationContinuations}/${MAX_TRUNCATION_CONTINUATIONS}) — continuing into the loop`,
          );
          emitStatus("⏳  [REI] Response hit the output limit — continuing");
          currentMessages.push(
            {
              role: "assistant",
              content: result.content,
              ...(result.reasoning
                ? { reasoning_content: result.reasoning }
                : {}),
            },
            { role: "user", content: TRUNCATION_CONTINUATION },
          );
          continue;
        }
        // Exhausted continuations. Apply whatever was validated on-green and report honestly
        // (raising REI_MAX_OUTPUT_TOKENS is the real fix for a model that keeps truncating).
        logger.logInfo(
          `[truncation] gave up after ${MAX_TRUNCATION_CONTINUATIONS} continuations — output cap too low for this model?`,
        );
        const truncEdits = await virtualEdits();
        return finalizeOutcome(
          logger,
          {
            response: appendCreatedSummary(
              firstTurnExplanation ||
                "⚠️ The model kept hitting the output-token limit before finishing. " +
                  "Increase REI_MAX_OUTPUT_TOKENS (thinking models need room for reasoning + the tool call).",
            ),
            validProposedPatches: truncEdits,
          },
          truncEdits.length,
          truncEdits.length,
        );
      }

      // Capture text explanation from first turn
      if (loopCount === 1 && result.content.trim()) {
        firstTurnExplanation = result.content.trim();
      }

      // ── No tool calls ──────────────────────────────────────────────────────
      if (result.toolCalls.length === 0) {
        // The model sometimes emits a tool call as TEXT/XML (e.g. "<read_files>...")
        // instead of using the native function-calling interface. That would be lost
        // as a plain-text answer. Nudge it back to the proper format and retry.
        if (
          looksLikeAttemptedToolCall(result.content) &&
          formatCorrections < MAX_FORMAT_CORRECTIONS &&
          loopCount < MAX_TURNS
        ) {
          formatCorrections++;
          logger.logInfo("[tools] format-correction", {
            attempt: formatCorrections,
            contentPreview: result.content.slice(0, 120),
          });
          currentMessages = [
            ...currentMessages,
            { role: "assistant", content: result.content },
            {
              role: "user",
              content:
                "You emitted a tool call as text/XML, which is not executable. " +
                "Do NOT write tool calls as text or XML tags. Use the native function-calling " +
                "interface to invoke the tools (read_files, edit_file, create_file, run_command) directly. " +
                "Retry the same action now using a proper tool call.",
            },
          ];
          continue;
        }

        // Genuine plain-text response = the model is done. Before finishing, run a
        // FINAL verify of the whole queued set (catches cross-edit breakage and any
        // create_file content that no per-batch check covered). If it fails and we
        // still have budget, bounce the diagnostics back for one more self-correction.
        let finalVerified: boolean | undefined = undefined;
        const finalEdits = await virtualEdits();
        if (finalEdits.length > 0) {
          const finalCheck = await validateProposedPatches({
            workspacePath,
            // direct mode already wrote edits to disk → verify the workspace as-is (empty edit
            // set = sandbox copy of current disk). sandbox mode applies the virtual tree.
            edits: directMode ? [] : finalEdits,
            loopCount,
            logger,
          });
          finalVerified = finalCheck.success;
          if (
            !finalCheck.success &&
            verifyRetries < MAX_VERIFY_RETRIES &&
            loopCount < MAX_TURNS
          ) {
            verifyRetries++;
            logger.logInfo(
              "[tools] final-verify failed — requesting self-correction",
              {
                attempt: verifyRetries,
              },
            );
            emitStatus(
              `🔁  [REI] Combined changes don't compile — asking the model to fix`,
            );
            currentMessages.push(
              { role: "assistant", content: result.content },
              {
                role: "user",
                content:
                  "Before finishing: your combined changes do NOT compile.\n" +
                  `${finalCheck.feedback ?? "(no diagnostics)"}\n` +
                  "Fix the affected file(s) with edit_file, then finish with a brief summary.",
              },
            );
            continue;
          }
        }

        const response =
          firstTurnExplanation && result.content !== firstTurnExplanation
            ? firstTurnExplanation + "\n\n" + result.content
            : result.content;

        // If the model finished without producing a text summary (applied edits and stopped),
        // request one explicitly via a dedicated summary turn (no tools — pure text).
        // This gives the user a natural explanation of what changed and why, the same way
        // capable hosted agents always close with a recap.
        const modifiedFiles = [...virtualFiles.keys()];
        const hasChanges = modifiedFiles.length > 0 || createdFiles.length > 0;
        let finalResponse = response.trim();
        // Request an explicit recap when the model applied changes but didn't explain them
        // clearly — EMPTY content (common when thinking is on: narration goes to `reasoning`)
        // OR a too-terse reply ("ok"/"done"/"listo") that isn't a real summary. Capable agents
        // always close with a clear recap of WHAT changed and WHY.
        if (hasChanges && finalResponse.length < 40) {
          emitStatus("📋  [REI] Generating summary...");
          const fileList = [...new Set([...modifiedFiles, ...createdFiles])];
          const summaryMessages: ChatMessage[] = [
            ...currentMessages,
            { role: "assistant", content: result.content },
            {
              role: "user",
              content:
                "Task complete. Write a concise recap for the user, plain text only (no tool " +
                "calls): for EACH file you changed, one line — `<file>: <what you changed and why>`. " +
                `Files changed this turn: ${fileList.join(", ")}.`,
            },
          ];
          const generated = await provider
            .completeChat(summaryMessages, { model: modelOverride })
            .catch(() => "");
          // Always guarantee a file list, even if the model's recap is weak/failed.
          finalResponse =
            generated.trim() ||
            `Done. Changes applied to:\n${fileList.map((f) => `- ${f}`).join("\n")}`;
        }

        // Safety net against "said it did something but didn't": the turn applied NOTHING, yet
        // the model wrote edit-like text (a fenced code block, an XML <edit>, or it kept failing
        // to emit a real tool call). Without this the user reads the intent prose and assumes the
        // change was made. Surface a loud, unmissable warning instead.
        const appliedNothing =
          modifiedFiles.length === 0 && createdFiles.length === 0;
        const impliedEdits =
          formatCorrections > 0 ||
          looksLikeAttemptedToolCall(result.content) ||
          /```/.test(result.content);
        if (appliedNothing && impliedEdits) {
          finalResponse =
            `\x1b[1m\x1b[33m⚠️  NO FILE WAS CHANGED.\x1b[0m The model described an edit but never ` +
            `emitted an \`edit_file\`/\`create_file\` tool call, so nothing was applied to disk. ` +
            `Re-run the step or rephrase the request.\n\n` +
            finalResponse;
        }

        return finalizeOutcome(
          logger,
          {
            response: appendCreatedSummary(finalResponse),
            validProposedPatches: finalEdits,
            verified: finalVerified,
          },
          finalEdits.length,
          finalEdits.length,
        );
      }

      // ── Process tool calls ─────────────────────────────────────────────────
      // Add the assistant message with tool_calls to history. Carry the reasoning
      // so it can be re-sent to the model when REI_PRESERVE_THINKING=true.
      currentMessages.push({
        role: "assistant",
        content: result.content,
        tool_calls: result.toolCalls,
        ...(result.reasoning ? { reasoning_content: result.reasoning } : {}),
      });

      let hasToolFailure = false;

      // Track edit tasks and all tool results by call ID to preserve correct response order
      const editTasks: EditTask[] = [];
      const toolResultsMap = new Map<string, string>();

      for (const call of result.toolCalls) {
        let toolResult: string;

        // `tool.<name>` span for each call. run_command and mcp:* tools are already traced at
        // their executors (executeCommand / McpRegistry.dispatch), so skip them here to avoid
        // double-wrapping; the inline built-ins have no shared executor and are traced here.
        const endTool =
          call.function.name === "run_command" ||
          call.function.name.startsWith("mcp:")
            ? null
            : startToolSpan(call.function.name, {
                arguments: call.function.arguments,
              });
        try {
          const args = JSON.parse(call.function.arguments) as Record<
            string,
            unknown
          >;

          switch (call.function.name) {
            // ── read_files ───────────────────────────────────────────────
            case "read_files": {
              const paths = (args.paths as string[]) ?? [];
              logger.logInfo(`[tools] read_files: ${paths.join(", ")}`);
              emitStatus(`🔍  [REI] Reading: ${paths.join(", ") || "(none)"}`);
              // Reflect the model's own pending (virtual) edits so re-reads show the WORKING
              // state, not stale disk — this keeps subsequent edit_file search blocks matching.
              // Dedup: if a file's content is unchanged since we last showed it, point the model
              // back to it instead of re-dumping the whole thing (it's still in history).
              const parts: string[] = [];
              for (const raw of paths) {
                const f = toRel(raw); // normalize absolute in-workspace paths to the virtual-tree key
                const cur = await currentContent(f);
                if (cur !== "" && alreadyProvided.get(f) === cur) {
                  parts.push(
                    `--- File: ${f} ---\n(unchanged since you last read it above — reuse that content; do not re-read)`,
                  );
                  continue;
                }
                if (virtualFiles.has(f)) {
                  parts.push(
                    `--- File: ${f} ---\n\`\`\`\n${virtualFiles.get(f)}\n\`\`\``,
                  );
                } else {
                  parts.push(
                    (
                      await buildFileContextMessage(workspacePath, [f])
                    ).trimStart(),
                  );
                }
                if (cur !== "") alreadyProvided.set(f, cur);
              }
              toolResult = "\n" + parts.join("\n\n");
              toolResultsMap.set(call.id, toolResult);
              break;
            }

            // ── search_tools (meta-tool) ─────────────────────────────────
            case "search_tools": {
              const q = (args.query as string) ?? "";
              const found = searchMcpTools(q, allMcpTools, SEARCH_K);
              found.forEach((t) => activeMcp.add(t.name));
              logger.logInfo(`[tools] search_tools: "${q}"`, {
                found: found.map((t) => t.name),
              });
              emitStatus(`🧰  [REI] Searching tools: ${q}`);
              toolResult = found.length
                ? "Loaded these tools — you can now call them directly:\n" +
                  found
                    .map((t) => `- ${t.name}: ${t.description ?? ""}`)
                    .join("\n")
                : `No tools matched "${q}". Try different keywords.`;
              toolResultsMap.set(call.id, toolResult);
              break;
            }

            // ── web_search (built-in) ────────────────────────────────────
            case "web_search": {
              const query = (args.query as string) ?? "";
              logger.logInfo(`[tools] web_search: "${query}"`);
              emitStatus(`🔍  [REI] Searching the web: ${query}`);
              const results = await searchWeb(query, provider);
              toolResult = `\n### 🔍 Search Results: ${query}\n${results}\n`;
              toolResultsMap.set(call.id, toolResult);
              break;
            }

            // ── weather (built-in) ───────────────────────────────────────
            case "weather": {
              const location = (args.location as string) ?? "";
              logger.logInfo(`[tools] weather: "${location}"`);
              emitStatus(`🌤️  [REI] Weather: ${location}`);
              const weatherRes = await getWeather(location);
              toolResult = `\n### 🌤️ Weather: ${location}\n${formatWeatherOutput(weatherRes)}\n`;
              toolResultsMap.set(call.id, toolResult);
              break;
            }

            // ── use_skill (meta-tool) ────────────────────────────────────
            case "use_skill": {
              const skillName = (args.name as string) ?? "";
              const skill = findSkill(skills, skillName);
              logger.logInfo(`[tools] use_skill: "${skillName}"`, {
                matched: skill?.name ?? null,
              });
              emitStatus(
                `📘  [REI] Loading skill: ${skill?.name ?? skillName}`,
              );
              toolResult = skill
                ? `Skill "${skill.name}" loaded — follow these steps:\n\n${skill.body}`
                : `No skill named "${skillName}". Available: ${skills.map((s) => s.name).join(", ") || "(none)"}.`;
              toolResultsMap.set(call.id, toolResult);
              break;
            }

            // ── edit_file ────────────────────────────────────────────────
            case "edit_file": {
              const file = resolveTarget(args.file);
              // Validate args up front: a missing search/replace would otherwise crash the
              // apply with `undefined.replace`. Return a precise error so the model retries
              // with both fields (common when it batches many edits and drops one).
              if (
                typeof args.search !== "string" ||
                typeof args.replace !== "string"
              ) {
                const missing = [
                  typeof args.search !== "string" ? "search" : null,
                  typeof args.replace !== "string" ? "replace" : null,
                ]
                  .filter(Boolean)
                  .join(" and ");
                toolResultsMap.set(
                  call.id,
                  `ERROR: edit_file to ${file} is missing the "${missing}" argument. ` +
                    `Both "search" (exact text to find) and "replace" (new text) are required strings. ` +
                    `Re-send this edit_file call with both fields filled in (keep using edit_file — ` +
                    `do NOT switch to rewriting the whole file).`,
                );
                hasToolFailure = true;
                break;
              }
              const edit: AgentSREdit = {
                file,
                search: args.search,
                replace: args.replace,
              };
              logger.logInfo(`[tools] edit_file: ${edit.file}`);
              emitStatus(`🛠️  [REI] Editing: ${edit.file}`);
              editTasks.push({ callId: call.id, edit });
              break;
            }

            // ── rewrite_file ─────────────────────────────────────────────
            // Whole-file overwrite. REI fills in the `search` with the EXACT current
            // file content (read from disk), so the model never has to reproduce it —
            // this sidesteps the search-mismatch problem entirely. The edit still goes
            // through the normal validation pipeline as a search→replace.
            case "rewrite_file": {
              const file = resolveTarget(args.file);
              const newContent = (args.content as string) ?? "";
              const absPath = resolveWorkspacePath(file, workspacePath);
              const current = await fs
                .readFile(absPath, "utf-8")
                .catch(() => null);
              logger.logInfo(`[tools] rewrite_file: ${file}`);
              emitStatus(`📝  [REI] Rewriting whole file: ${file}`);
              if (current === null) {
                // Doesn't exist yet — just write it (like create_file).
                await fs.mkdir(path.dirname(absPath), { recursive: true });
                await fs.writeFile(absPath, newContent, "utf-8");
                createdFiles.push(file);
                toolResultsMap.set(call.id, `OK: ${file} created`);
              } else {
                // Authoritative whole-file overwrite. In the virtual tree this simply REPLACES
                // the file's accumulated content (superseding any prior edits to it) — no search
                // matching needed, so it can't "poison" later edits.
                editTasks.push({
                  callId: call.id,
                  edit: { file, search: current, replace: newContent },
                  wholeFile: true,
                });
              }
              break;
            }

            // ── create_file ──────────────────────────────────────────────
            case "create_file": {
              const file = resolveTarget(args.file);
              const filePath = resolveWorkspacePath(file, workspacePath);
              const exists = await fs
                .stat(filePath)
                .then(() => true)
                .catch(() => false);
              emitStatus(`📂  [REI] Creating: ${file}`);
              if (exists) {
                toolResult = `SKIPPED: ${file} already exists — use edit_file to modify it (or rewrite_file to overwrite it entirely)`;
              } else {
                await fs.mkdir(path.dirname(filePath), { recursive: true });
                await fs.writeFile(filePath, args.content as string, "utf-8");
                logger.logInfo(`[tools] create_file: ${file}`);
                createdFiles.push(file);
                toolResult = `OK: ${file} created`;
              }
              toolResultsMap.set(call.id, toolResult);
              break;
            }

            // ── run_command ──────────────────────────────────────────────
            case "run_command": {
              const cmd = args.command as string;
              logger.logInfo(`[tools] run_command: ${cmd}`);
              emitStatus(`💻  [REI] Running: ${cmd}`);
              const cmdResult = await executeCommand(cmd, workspacePath);
              logger.logCommandExecution(cmd, cmdResult);
              const stdout = limitCommandOutput(cmdResult.stdout ?? "");
              const stderr = limitCommandOutput(cmdResult.stderr ?? "");
              toolResult =
                `Exit: ${cmdResult.exitCode}\n` +
                  (stdout ? `Stdout:\n${stdout}\n` : "") +
                  (stderr ? `Stderr:\n${stderr}\n` : "") || "(no output)";
              toolResultsMap.set(call.id, toolResult);
              break;
            }

            default: {
              if (call.function.name.startsWith("mcp:") && mcpRegistry) {
                // Strip the "mcp:" namespace prefix added by mcpToolsToDefinitions before
                // dispatching — the registry key is "serverName/toolName" not "mcp:...".
                const qualifiedName = call.function.name.slice(4);
                logger.logInfo(`[tools] mcp: ${qualifiedName}`);
                emitStatus(`🔧  [REI] Tool: ${qualifiedName}`);
                toolResult = await mcpRegistry.dispatch(qualifiedName, args);
              } else {
                toolResult = `ERROR: Unknown tool "${call.function.name}"`;
                hasToolFailure = true;
              }
              toolResultsMap.set(call.id, toolResult);
            }
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          toolResultsMap.set(call.id, `ERROR: ${msg}`);
          hasToolFailure = true;
        } finally {
          endTool?.();
        }
      }

      // Apply this turn's edits onto the CURRENT virtual content (cumulative), per file & in
      // order; then validate the WHOLE virtual tree. This catches cross-file breakage (e.g. an
      // Angular template referencing a member added in its .ts) while letting interdependent
      // files be fixed across turns. Search blocks are matched against the working content the
      // model is shown, so already-edited files don't "poison" later edits.
      // After repeated search mismatches, hold the affected files + escalation mode here so we
      // can act AFTER the tool results are fed back.
      let mismatchEscalation: {
        files: string[];
        mode: "inject" | "wholefile";
      } | null = null;
      if (editTasks.length > 0) {
        const candidate = new Map(virtualFiles);
        let mismatchFile: string | null = null;
        let mismatchError: string | null = null;
        for (const task of editTasks) {
          const f = task.edit.file;
          if (task.wholeFile) {
            candidate.set(f, task.edit.replace); // rewrite_file: authoritative content
            continue;
          }
          const base = candidate.has(f) ? candidate.get(f)! : await readDisk(f);
          const res = applyFileEdits(base, [task.edit]);
          if (!res.success) {
            mismatchFile = f;
            mismatchError = res.error ?? `Could not apply edit to ${f}`;
            break;
          }
          candidate.set(f, res.newContent!);
        }

        if (mismatchFile) {
          // Search block didn't match the working content → mismatch death-loop tracking.
          hasToolFailure = true;
          consecutiveSearchMismatchFailures += 1;
          for (const task of editTasks) {
            toolResultsMap.set(task.callId, `ERROR: ${mismatchError}`);
          }
          const files = [mismatchFile];
          if (consecutiveSearchMismatchFailures >= MISMATCH_WHOLEFILE_AT) {
            mismatchEscalation = { files, mode: "wholefile" };
          } else if (consecutiveSearchMismatchFailures === MISMATCH_INJECT_AT) {
            mismatchEscalation = { files, mode: "inject" };
          }
        } else if (directMode) {
          // DIRECT mode: apply to disk immediately with NO per-edit compile-check. The model
          // verifies via run_command (it sees the real disk) and REI does ONE final verify when
          // the model finishes. Lighter and loop-free; partial edits persist if the task aborts.
          consecutiveSearchMismatchFailures = 0;
          for (const [f, c] of candidate) virtualFiles.set(f, c);
          await persistToDisk([...new Set(editTasks.map((t) => t.edit.file))]);
          setEditResults(editTasks, candidate, toolResultsMap, alreadyProvided);
        } else {
          // SANDBOX mode (default): validate the CUMULATIVE virtual tree (compile check),
          // expressed as whole-file rewrites from disk (search = exact disk content, never
          // mismatches in the sandbox). Persist only the green state.
          const candidateEdits: AgentSREdit[] = [];
          for (const [f, c] of candidate) {
            candidateEdits.push({
              file: f,
              search: await readDisk(f),
              replace: c,
            });
          }
          const validation = await validateProposedPatches({
            workspacePath,
            edits: candidateEdits,
            loopCount,
            logger,
          });

          if (validation.success) {
            consecutiveSearchMismatchFailures = 0;
            for (const [f, c] of candidate) virtualFiles.set(f, c); // commit to virtual tree
            // Persist on-green so the model's OWN run_command (ngc/head/tests) sees its work.
            // Queued edits are otherwise invisible to disk-reading commands, which makes the
            // model believe its edits "didn't apply" (it even theorizes a hook is reverting
            // them) and spiral. Disk now always reflects the last validated state.
            await persistToDisk([
              ...new Set(editTasks.map((t) => t.edit.file)),
            ]);
            setEditResults(editTasks, candidate, toolResultsMap, alreadyProvided);
          } else {
            hasToolFailure = true;
            // Compile error (not a search mismatch) → reset the mismatch streak.
            consecutiveSearchMismatchFailures = 0;
            for (const task of editTasks) {
              toolResultsMap.set(
                task.callId,
                `ERROR: ${validation.feedback ?? "combined changes do not compile"}`,
              );
            }
          }
        }
      }

      // Feed back all tool results to model history in correct chronological order
      for (const call of result.toolCalls) {
        const res =
          toolResultsMap.get(call.id) ?? "ERROR: Tool execution failed";
        currentMessages.push({
          role: "tool",
          content: res,
          tool_call_id: call.id,
          name: call.function.name,
        });
      }

      // Escalation against the SR mismatch death-loop.
      if (mismatchEscalation) {
        const { files, mode } = mismatchEscalation;
        if (mode === "inject") {
          // Tier 1: hand the model the exact current content so it can copy the
          // search block verbatim.
          logger.logInfo(
            `[tools] auto-injecting file context after repeated search mismatches: ${files.join(", ")}`,
          );
          emitStatus(
            `📄  [REI] Re-sending exact file content so edits match: ${files.join(", ")}`,
          );
          // Show the WORKING content (pending virtual edits if any), not stale disk, so the
          // model's next search block matches the state its edits will actually apply against.
          const contextMessage =
            "\n" +
            (
              await Promise.all(
                files.map(
                  async (f) =>
                    `--- File: ${f} ---\n\`\`\`\n${await currentContent(f)}\n\`\`\``,
                ),
              )
            ).join("\n\n");
          currentMessages.push({
            role: "user",
            content:
              "Your edit_file `search` blocks did NOT match the file content exactly. " +
              "Below is the current, exact content of the file(s). Copy the `search` text " +
              "VERBATIM from here (including indentation and whitespace), then retry edit_file:\n" +
              contextMessage,
          });
        } else {
          // Tier 2: it still can't match even with the file in hand. Stop using
          // edit_file — instruct it to overwrite the whole file via rewrite_file,
          // which has no exact-match requirement.
          logger.logInfo(
            `[tools] escalating to whole-file rewrite after persistent mismatches: ${files.join(", ")}`,
          );
          emitStatus(
            `🔁  [REI] edit_file keeps failing — switching to whole-file rewrite: ${files.join(", ")}`,
          );
          currentMessages.push({
            role: "user",
            content:
              `edit_file keeps failing to match the search block for ${files.join(", ")}. ` +
              "STOP using edit_file for these file(s). Instead call `rewrite_file` with the " +
              "file path and its COMPLETE corrected content — you do not need to match any " +
              "search text. Use the exact file content shown above as your starting point.",
          });
        }
      }

      // Do NOT return here just because we have valid edits — keep looping so the
      // model can edit additional files in the same task. We apply everything once
      // the model signals completion (a plain-text response, handled above, which
      // returns the accumulated virtual tree as `validProposedPatches`). Reads, commands,
      // queued edits and failures all simply continue the loop.
    } finally {
      endStep();
    }
  }

  // Hit the turn limit. If the model queued edits along the way, apply them rather
  // than discard the work; otherwise report the failure with guidance. No budget
  // left to self-correct, but still run a final verify so `verified` is honest.
  const limitEdits = await virtualEdits();
  if (limitEdits.length > 0) {
    const finalCheck = await validateProposedPatches({
      workspacePath,
      edits: directMode ? [] : limitEdits,
      loopCount,
      logger,
    });
    return finalizeOutcome(
      logger,
      {
        response: appendCreatedSummary(
          firstTurnExplanation ||
            `Applied ${limitEdits.length} edit(s); stopped at the ${MAX_TURNS}-turn limit (there may be more to do).`,
        ),
        validProposedPatches: limitEdits,
        verified: finalCheck.success,
      },
      limitEdits.length,
      limitEdits.length,
    );
  }

  return finalizeOutcome(
    logger,
    {
      response: [
        `⚠️ REI could not complete the task after ${loopCount} attempts.`,
        "",
        ...(firstTurnExplanation
          ? ["**What was planned:**", firstTurnExplanation, ""]
          : []),
        "**What to try next:**",
        '- Ask REI to re-read the files first: *"Read [file] and retry"*',
        `- Increase the turn limit: set \`REI_MAX_TURNS=${MAX_TURNS + 3}\` in your .env`,
      ].join("\n"),
      validProposedPatches: [],
      failed: true,
    },
    0,
    0,
  );
}
