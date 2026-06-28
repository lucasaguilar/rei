/**
 * Agent mode generator using structured function/tool calling.
 * Used when the active provider implements completeChatWithTools.
 * Falls back to the XML-based generator if not.
 */
import type { ChatMessage } from "../chat/types.js";
import type { ModelProvider } from "../providers/model-provider.js";
import type { AgentLogger } from "../core/logger.js";
import type { McpRegistry } from "../tools/mcp/mcp-registry.js";
import { mcpToolsToDefinitions } from "../contracts/tool-definitions.js";
import { startStepSpan } from "../telemetry/spans.js";
import { getMaxTurns } from "../config/model-runtime.js";
import {
  finalizeOutcome,
  validateProposedPatches,
  CREATED_FILES_MARKER,
  type ExecutionResult,
} from "./helpers/patch-helpers.js";
import { setupToolSelection } from "./tools-loop/tool-selection.js";
import { callModel } from "./tools-loop/call-model.js";
import { createVirtualFileTree } from "./tools-loop/virtual-file-tree.js";
import { dispatchToolCalls } from "./tools-loop/dispatch-tool-calls.js";
import { applyEditBatch, setEditResults } from "./tools-loop/apply-edit-batch.js";
import { handleTextResponse } from "./tools-loop/handle-text-response.js";
import { buildMismatchEscalationMessage } from "./tools-loop/mismatch-escalation.js";

// Re-exported for back-compat (it moved into tools-loop/apply-edit-batch during the Phase 2 refactor).
export { setEditResults };

const MAX_TURNS = getMaxTurns();
const MAX_TRUNCATION_CONTINUATIONS = 3;
const TRUNCATION_CONTINUATION =
  "Your previous response was cut off by the output token limit. " +
  "Continue EXACTLY from where you left off — do NOT repeat, summarize, or restart. " +
  "Just continue the text as one uninterrupted response.";

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

  // Tool selection (built-in + web_search/weather + MCP with on-demand tool-search + skills) is
  // extracted into setupToolSelection (Phase 2). `activeMcp` is returned MUTABLE so the
  // search_tools handler below can grow it by reference.
  const { buildTools, activeMcp, allMcpTools, useToolSearch, skills } = setupToolSelection({
    mcpRegistry,
    messagesForModel,
    userQuery,
    workspacePath,
    logger,
  });

  let currentMessages: ChatMessage[] = withNativeToolsDirective([
    ...messagesForModel,
  ]);
  let loopCount = 0;
  let firstTurnExplanation = "";
  // Format-correction nudges (model emitted a tool call as text/XML) and final-verify
  // self-correction retries — both capped inside handleTextResponse, threaded across turns here.
  let formatCorrections = 0;
  let verifyRetries = 0;
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
  // The in-memory file state for this turn — virtualFiles/diskCache/alreadyProvided maps plus the
  // read/resolve/persist helpers (extracted, Phase 2). The maps are mutated BY REFERENCE by the
  // tool handlers below.
  const {
    virtualFiles,
    diskCache,
    alreadyProvided,
    toRel,
    resolveTarget,
    readDisk,
    currentContent,
    virtualEdits,
    persistToDisk,
  } = createVirtualFileTree(workspacePath);

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

      // One model call: provider invocation + logging + live reasoning (extracted, Phase 2).
      const result = await callModel({
        provider,
        messages: currentMessages,
        tools: buildTools(),
        modelOverride,
        reasoningEffort,
        logger,
        onChunk,
      });

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
      // The model returned plain text: either a faked-as-text tool call (nudge + continue), a
      // completion that fails final verify (self-correct + continue), or a genuine finish.
      if (result.toolCalls.length === 0) {
        const outcome = await handleTextResponse({
          content: result.content,
          currentMessages,
          loopCount,
          maxTurns: MAX_TURNS,
          formatCorrections,
          verifyRetries,
          workspacePath,
          directMode,
          logger,
          emitStatus,
          provider,
          modelOverride,
          firstTurnExplanation,
          virtualFiles,
          virtualEdits,
          createdFiles,
          appendCreatedSummary,
        });
        if (outcome.action === "finalize") return outcome.result;
        currentMessages = outcome.messages;
        formatCorrections = outcome.formatCorrections;
        verifyRetries = outcome.verifyRetries;
        continue;
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

      // Execute every tool call in this turn (spans + arg-parse + dispatch to the extracted
      // handlers). Edits are only QUEUED into editTasks here; we apply them as a batch below.
      let { hasToolFailure, editTasks, toolResultsMap } = await dispatchToolCalls(
        result.toolCalls,
        {
          workspacePath,
          logger,
          emitStatus,
          provider,
          mcpRegistry,
          toRel,
          currentContent,
          virtualFiles,
          alreadyProvided,
          allMcpTools,
          activeMcp,
          skills,
          resolveTarget,
          createdFiles,
        },
      );

      // Apply this turn's edits onto the CURRENT virtual content (cumulative), per file & in
      // order; then validate the WHOLE virtual tree. This catches cross-file breakage (e.g. an
      // Angular template referencing a member added in its .ts) while letting interdependent
      // files be fixed across turns. Search blocks are matched against the working content the
      // model is shown, so already-edited files don't "poison" later edits.
      // After repeated search mismatches, hold the affected files + escalation mode here so we
      // can act AFTER the tool results are fed back.
      // Apply the queued edits to the virtual tree, then persist (direct) or validate-then-persist
      // (sandbox). Mutates the maps by reference; returns the failure/escalation decisions.
      const batch = await applyEditBatch(editTasks, {
        workspacePath,
        loopCount,
        directMode,
        mismatchStreak: consecutiveSearchMismatchFailures,
        injectAt: MISMATCH_INJECT_AT,
        wholefileAt: MISMATCH_WHOLEFILE_AT,
        logger,
        virtualFiles,
        toolResultsMap,
        alreadyProvided,
        readDisk,
        persistToDisk,
      });
      if (batch.failed) hasToolFailure = true;
      consecutiveSearchMismatchFailures = batch.mismatchStreak;
      const mismatchEscalation = batch.mismatchEscalation;

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
        currentMessages.push({
          role: "user",
          content: await buildMismatchEscalationMessage(mismatchEscalation, {
            logger,
            emitStatus,
            currentContent,
          }),
        });
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
