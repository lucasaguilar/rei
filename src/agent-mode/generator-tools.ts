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
import { AGENT_TOOLS, mcpToolsToDefinitions } from "../contracts/tool-definitions.js";
import { executeCommand, limitCommandOutput } from "../tools/command-executor.js";
import { startStepSpan, startToolSpan } from "../telemetry/spans.js";
import {
  searchMcpTools,
  SEARCH_TOOLS_DEF,
  MAX_UNFILTERED,
  PRELOAD_K,
  SEARCH_K,
} from "../tools/tool-retriever.js";
import { getMaxTurns } from "../config/model-runtime.js";
import { loadSkills, buildUseSkillTool, findSkill, skillsForMode } from "../skills/skill-loader.js";
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
  return /<\s*(read_files|edit_file|create_file|run_command|edit|create|wholefile|request_files|execute_command|call_tool)\b/i.test(
    content,
  ) || /<parameter\s*=/i.test(content);
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
  /** Connected MCP registry. When provided, MCP tools are merged into the tool list. */
  mcpRegistry?: McpRegistry;
  /** Live progress callback — emits "status" chunks as each tool runs so the
   *  user sees activity (this path is otherwise silent until the turn ends). */
  onChunk?: (event: { type: "thinking" | "text" | "status"; content: string }) => void;
  /** Raw user request, used by tool-RAG to select only relevant MCP tools. */
  userQuery?: string;
}): Promise<ExecutionResult> {
  const { provider, messagesForModel, workspacePath, logger, modelOverride, mcpRegistry, onChunk, userQuery } = params;

  if (!provider.completeChatWithTools) {
    throw new Error("executeAgentTurnWithTools: provider does not support completeChatWithTools");
  }

  // Emits a one-line live status for a tool action (shown immediately by the CLI).
  const emitStatus = (msg: string) => onChunk?.({ type: "status", content: `\n\x1b[33m${msg}\x1b[0m\n` });

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
    const tools = [...AGENT_TOOLS, ...mcp];
    if (useToolSearch) tools.push(SEARCH_TOOLS_DEF);
    if (useSkillTool) tools.push(useSkillTool);
    return tools;
  };

  let currentMessages: ChatMessage[] = [...messagesForModel];
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

  // Edits accumulate ACROSS iterations so the model can fix multiple files in one
  // turn (read → edit fileA → edit fileB → … → done). They are applied by the caller
  // only when the model finishes (emits a plain-text answer, no more tool calls).
  const pendingEdits: AgentSREdit[] = [];

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
      { model: modelOverride },
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
      onChunk?.({ type: "thinking", content: result.reasoning.trim() + "\n" });
    }

    // Auto-continue if truncated (no tool calls and output was cut off)
    if (result.finishReason === "length" && result.toolCalls.length === 0) {
      let accumulated = result.content;
      let truncationCount = 0;
      let lastReason = result.finishReason;

      while (lastReason === "length" && truncationCount < MAX_TRUNCATION_CONTINUATIONS) {
        truncationCount++;
        logger.logInfo(`[truncation] tools response cut off (${truncationCount}/${MAX_TRUNCATION_CONTINUATIONS}), continuing...`);
        currentMessages = [
          ...currentMessages,
          { role: "assistant", content: accumulated },
          { role: "user", content: TRUNCATION_CONTINUATION },
        ];
        const cont = await provider.completeChatWithTools!(
          currentMessages,
          AGENT_TOOLS,
          { model: modelOverride },
        );
        accumulated = accumulated + cont.content;
        lastReason = cont.finishReason;
        currentMessages = currentMessages.slice(0, currentMessages.length - 2);
      }

      return finalizeOutcome(logger, {
        response: appendCreatedSummary(firstTurnExplanation || accumulated),
        validProposedPatches: [],
      }, 0, 0);
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
      if (pendingEdits.length > 0) {
        const finalCheck = await validateProposedPatches({
          workspacePath,
          edits: pendingEdits,
          loopCount,
          logger,
        });
        finalVerified = finalCheck.success;
        if (!finalCheck.success && verifyRetries < MAX_VERIFY_RETRIES && loopCount < MAX_TURNS) {
          verifyRetries++;
          logger.logInfo("[tools] final-verify failed — requesting self-correction", {
            attempt: verifyRetries,
          });
          emitStatus(`🔁  [REI] Combined changes don't compile — asking the model to fix`);
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

      const response = firstTurnExplanation && result.content !== firstTurnExplanation
        ? firstTurnExplanation + "\n\n" + result.content
        : result.content;
      return finalizeOutcome(
        logger,
        {
          response: appendCreatedSummary(response),
          validProposedPatches: pendingEdits,
          verified: finalVerified,
        },
        pendingEdits.length,
        pendingEdits.length,
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
    interface EditTask {
      callId: string;
      edit: AgentSREdit;
    }
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
        const args = JSON.parse(call.function.arguments) as Record<string, unknown>;

        switch (call.function.name) {
          // ── read_files ───────────────────────────────────────────────
          case "read_files": {
            const paths = (args.paths as string[]) ?? [];
            logger.logInfo(`[tools] read_files: ${paths.join(", ")}`);
            emitStatus(`🔍  [REI] Reading: ${paths.join(", ") || "(none)"}`);
            toolResult = await buildFileContextMessage(workspacePath, paths);
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
                found.map((t) => `- ${t.name}: ${t.description ?? ""}`).join("\n")
              : `No tools matched "${q}". Try different keywords.`;
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
            emitStatus(`📘  [REI] Loading skill: ${skill?.name ?? skillName}`);
            toolResult = skill
              ? `Skill "${skill.name}" loaded — follow these steps:\n\n${skill.body}`
              : `No skill named "${skillName}". Available: ${skills.map((s) => s.name).join(", ") || "(none)"}.`;
            toolResultsMap.set(call.id, toolResult);
            break;
          }

          // ── edit_file ────────────────────────────────────────────────
          case "edit_file": {
            const edit: AgentSREdit = {
              file: args.file as string,
              search: args.search as string,
              replace: args.replace as string,
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
            const file = args.file as string;
            const newContent = (args.content as string) ?? "";
            const absPath = path.join(workspacePath, file);
            const current = await fs.readFile(absPath, "utf-8").catch(() => null);
            logger.logInfo(`[tools] rewrite_file: ${file}`);
            emitStatus(`📝  [REI] Rewriting whole file: ${file}`);
            if (current === null) {
              // Doesn't exist yet — just write it (like create_file).
              await fs.mkdir(path.dirname(absPath), { recursive: true });
              await fs.writeFile(absPath, newContent, "utf-8");
              createdFiles.push(file);
              toolResultsMap.set(call.id, `OK: ${file} created`);
            } else {
              // Authoritative overwrite: drop any partial edits to this file already
              // queued this turn. They're superseded by the full rewrite, and would
              // otherwise conflict at final apply (their search no longer matches once
              // the file is replaced). `search` = exact current disk content → matches.
              const superseded = pendingEdits.filter((e) => e.file === file).length;
              if (superseded > 0) {
                for (let i = pendingEdits.length - 1; i >= 0; i--) {
                  if (pendingEdits[i].file === file) pendingEdits.splice(i, 1);
                }
                logger.logInfo(`[tools] rewrite_file superseded ${superseded} queued edit(s) for ${file}`);
              }
              editTasks.push({
                callId: call.id,
                edit: { file, search: current, replace: newContent },
              });
            }
            break;
          }

          // ── create_file ──────────────────────────────────────────────
          case "create_file": {
            const filePath = path.join(workspacePath, args.file as string);
            const exists = await fs.stat(filePath).then(() => true).catch(() => false);
            emitStatus(`📂  [REI] Creating: ${args.file}`);
            if (exists) {
              toolResult = `SKIPPED: ${args.file} already exists — use edit_file to modify it (or rewrite_file to overwrite it entirely)`;
            } else {
              await fs.mkdir(path.dirname(filePath), { recursive: true });
              await fs.writeFile(filePath, args.content as string, "utf-8");
              logger.logInfo(`[tools] create_file: ${args.file}`);
              createdFiles.push(args.file as string);
              toolResult = `OK: ${args.file} created`;
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
            toolResult = `Exit: ${cmdResult.exitCode}\n` +
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

    // Validate ONLY this turn's batch, against the on-disk file content — which is
    // exactly what the model sees (queued pendingEdits are NOT written to disk during
    // the loop). Validating the cumulative set here was wrong: it enforced a sandbox
    // state the model can't observe, so any further edit to an already-edited file
    // mismatched ("poisoned file"), and even rewrite_file broke. The combined set is
    // still checked once at the end by the final verify (C2).
    // After repeated search mismatches, hold the affected files + escalation mode
    // here so we can act AFTER the tool results are fed back.
    let mismatchEscalation: { files: string[]; mode: "inject" | "wholefile" } | null = null;
    if (editTasks.length > 0) {
      const batchEdits = editTasks.map((t) => t.edit);
      const validation = await validateProposedPatches({
        workspacePath,
        edits: batchEdits,
        loopCount,
        logger,
      });

      if (validation.success) {
        consecutiveSearchMismatchFailures = 0;
        pendingEdits.push(...batchEdits);
        for (const task of editTasks) {
          toolResultsMap.set(
            task.callId,
            `OK: edit to ${task.edit.file} validated and queued. ` +
              `If OTHER files still need changes for this task, edit them now too. ` +
              `When ALL changes are done, reply with a brief summary (no tool call).`,
          );
        }
      } else {
        hasToolFailure = true;
        // Count a search-mismatch streak; a compile error (not a mismatch) resets it.
        consecutiveSearchMismatchFailures = validation.mismatchOnly
          ? consecutiveSearchMismatchFailures + 1
          : 0;
        for (const task of editTasks) {
          toolResultsMap.set(
            task.callId,
            `ERROR: ${validation.feedback ?? "compilation or search block mismatch in batch"}`
          );
        }
        // Escalate the mismatch death-loop. Counter does NOT reset here (only on
        // success), so it climbs through both tiers.
        if (validation.mismatchOnly) {
          const files = [...new Set(batchEdits.map((e) => e.file))];
          if (consecutiveSearchMismatchFailures >= MISMATCH_WHOLEFILE_AT) {
            mismatchEscalation = { files, mode: "wholefile" };
          } else if (consecutiveSearchMismatchFailures === MISMATCH_INJECT_AT) {
            mismatchEscalation = { files, mode: "inject" };
          }
        }
      }
    }

    // Feed back all tool results to model history in correct chronological order
    for (const call of result.toolCalls) {
      const res = toolResultsMap.get(call.id) ?? "ERROR: Tool execution failed";
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
        emitStatus(`📄  [REI] Re-sending exact file content so edits match: ${files.join(", ")}`);
        const contextMessage = await buildFileContextMessage(workspacePath, files);
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
        emitStatus(`🔁  [REI] edit_file keeps failing — switching to whole-file rewrite: ${files.join(", ")}`);
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
    // returns `validProposedPatches: pendingEdits`). Reads, commands, queued edits
    // and failures all simply continue the loop.
    } finally {
      endStep();
    }
  }

  // Hit the turn limit. If the model queued edits along the way, apply them rather
  // than discard the work; otherwise report the failure with guidance. No budget
  // left to self-correct, but still run a final verify so `verified` is honest.
  if (pendingEdits.length > 0) {
    const finalCheck = await validateProposedPatches({
      workspacePath,
      edits: pendingEdits,
      loopCount,
      logger,
    });
    return finalizeOutcome(
      logger,
      {
        response: appendCreatedSummary(
          firstTurnExplanation ||
            `Applied ${pendingEdits.length} edit(s); stopped at the ${MAX_TURNS}-turn limit (there may be more to do).`,
        ),
        validProposedPatches: pendingEdits,
        verified: finalCheck.success,
      },
      pendingEdits.length,
      pendingEdits.length,
    );
  }

  return finalizeOutcome(
    logger,
    {
      response: [
        `⚠️ REI could not complete the task after ${loopCount} attempts.`,
        "",
        ...(firstTurnExplanation ? ["**What was planned:**", firstTurnExplanation, ""] : []),
        "**What to try next:**",
        "- Ask REI to re-read the files first: *\"Read [file] and retry\"*",
        `- Increase the turn limit: set \`REI_MAX_TURNS=${MAX_TURNS + 3}\` in your .env`,
      ].join("\n"),
      validProposedPatches: [],
      failed: true,
    },
    0,
    0,
  );
}
