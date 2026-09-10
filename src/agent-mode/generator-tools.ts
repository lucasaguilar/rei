/** Agent mode generator using structured function/tool calling (provider must implement
 *  completeChatWithTools; falls back to the XML-based generator otherwise). */
import type { ChatMessage } from "../chat/types.js";
import type { ModelProvider, TokenUsage } from "../providers/model-provider.js";
import { mergeTurnUsage } from "../providers/token-usage.js";
import type { AgentLogger } from "../core/logger.js";
import type { McpRegistry } from "../tools/mcp/mcp-registry.js";
import { mcpToolsToDefinitions } from "../contracts/tool-definitions.js";
import { retainAndMaybeSpill } from "./tools-loop/tool-output-store.js";
import { pruneSupersededReads } from "./tools-loop/prune-superseded-reads.js";
import { startStepSpan } from "../telemetry/spans.js";
import { getMaxTurns } from "../config/model-runtime.js";
import {
  CREATED_FILES_MARKER,
  type ExecutionResult,
} from "./helpers/patch-helpers.js";
import { setupToolSelection } from "./tools-loop/tool-selection.js";
import { callModel } from "./tools-loop/call-model.js";
import { createVirtualFileTree } from "./tools-loop/virtual-file-tree.js";
import { dispatchToolCalls } from "./tools-loop/dispatch-tool-calls.js";
import type { ElicitFn } from "../chat/elicitation.js";
import { applyEditBatch, setEditResults } from "./tools-loop/apply-edit-batch.js";
import { handleTextResponse } from "./tools-loop/handle-text-response.js";
import {
  handleTruncation,
  buildTurnLimitOutcome,
} from "./tools-loop/turn-outcomes.js";
import { buildMismatchEscalationMessage } from "./tools-loop/mismatch-escalation.js";
import {
  evaluateBlockedRepeats,
  BLOCKED_REPEAT_STOP_MESSAGE,
} from "./tools-loop/blocked-repeat-guard.js";
import { evaluateNoProduce, produceThresholds, PRODUCE_NOW_MESSAGE } from "./tools-loop/no-produce-guard.js";
import { withNativeToolsDirective } from "./native-tools-directive.js";
import type { SkillMode } from "../skills/skill-loader.js";

// Re-exported for back-compat (it moved into tools-loop/apply-edit-batch during the Phase 2 refactor).
export { setEditResults };

const MAX_TURNS = getMaxTurns();

// The native-tools directive moved into its own module; re-exported here for existing importers.
export { withNativeToolsDirective };

/**
 * Executes an agent turn using native function/tool calling instead of XML parsing.
 * Returns the same ExecutionResult shape as the XML generator so callers are interchangeable.
 */
/**
 * Tools whose result is NOT spilled, each for a reason — the exemption is the exception, so a tool
 * added tomorrow is protected by default rather than forgotten.
 *
 * `read_files` already pages: the model passed an explicit offset/limit and is told when there is
 * more, so a second truncation on top would cut what it deliberately asked for. `use_skill` returns
 * a recipe that only works whole. The rest are already short by construction — an answer, a
 * summary, a receipt — and spilling a receipt produces a receipt for a receipt.
 */
const SPILL_EXEMPT = new Set([
  "read_files",
  "use_skill",
  "ask_user",
  "delegate",
  "save_tool_output",
]);

const spillExempt = (toolName: string): boolean => SPILL_EXEMPT.has(toolName);

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
  /** Live progress callback — emits "status" chunks as each tool runs (else silent until end). */
  onChunk?: (event: {
    type: "thinking" | "text" | "status";
    content: string;
    /**
     * What a "status" is about. `tool` (the default) means a tool ran, so the text before it was
     * narration; `notice` means the SAME answer is still being written — the output-limit
     * continuation. Consumers that treat a status as a boundary in the model's prose must not
     * treat a notice as one. Optional so the other declarations of this shape stay compatible.
     */
    kind?: "tool" | "notice";
  }) => void;
  /** Raw user request, used by tool-RAG to select only relevant MCP tools. */
  userQuery?: string;
  /** Mode whose tool-permission profile + directive govern this turn. Defaults to "agent". */
  mode?: SkillMode;
  /** An active role's `writeGlob` — narrows what this turn may write. See write-scope. */
  roleWriteGlob?: string;
  /** ask_user elicitation; frontend-provided, else the dispatch uses the non-interactive default. */
  elicit?: ElicitFn;
  /** Sub-agent nesting depth. 0 = orchestrator (can delegate); >0 = worker (no `delegate` tool). */
  depth?: number;
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
    mode = "agent",
    elicit,
    depth = 0,
    roleWriteGlob,
  } = params;

  if (!provider.completeChatWithTools) {
    throw new Error(
      "executeAgentTurnWithTools: provider does not support completeChatWithTools",
    );
  }

  // Emits a one-line live status for a tool action (shown immediately by the CLI).
  const emitStatus = (msg: string, kind: "tool" | "notice" = "tool") =>
    onChunk?.({ type: "status", content: `\n\x1b[33m${msg}\x1b[0m\n`, kind });

  // Tool selection lives in setupToolSelection. `activeMcp` returned MUTABLE (search_tools grows it).
  const { buildTools, activeMcp, allMcpTools, useToolSearch, skills } = setupToolSelection({
    mcpRegistry,
    messagesForModel,
    userQuery,
    workspacePath,
    logger,
    mode,
    allowSubAgents: depth === 0,
  });

  let currentMessages: ChatMessage[] = withNativeToolsDirective(
    [...messagesForModel],
    mode,
  );
  let loopCount = 0;
  let firstTurnExplanation = "";
  // Format-correction nudges (model emitted a tool call as text/XML) and final-verify
  // self-correction retries — both capped inside handleTextResponse, threaded across turns here.
  let formatCorrections = 0;
  let verifyRetries = 0;
  // Caps how many CONSECUTIVE times a turn that truncated mid-output (hit the output-token cap
  // before emitting a tool call — common with thinking models) is continued back into the loop.
  // Reset to 0 after any productive turn (see below), so an early streak doesn't starve later turns.
  let truncationContinuations = 0;
  // Tracks consecutive search-block mismatches (edit_file whose <search> isn't found verbatim).
  // Two-tier escalation for weak local models that can't reproduce exact search text:
  //   - at 2: inject the file's exact content so it can copy the search verbatim.
  //   - at 4: still no match → switch it to rewrite_file (whole-file, no match requirement).
  // Resets on a successful edit.
  let consecutiveSearchMismatchFailures = 0;
  const MISMATCH_INJECT_AT = 2;
  const MISMATCH_WHOLEFILE_AT = 4;
  // Files created via create_file across the loop — surfaced to the user, since
  // the native tool path otherwise only reports creation back to the model.
  const createdFiles: string[] = [];

  // Token usage aggregated across this turn's model calls (max prompt / sum completion).
  // Attached to the final ExecutionResult so the CLI can show REAL token counts.
  let turnUsage: TokenUsage | undefined;

  // run_command loop-guard: command → times executed. The dispatcher blocks an exact repeat (no
  // progress — the classic find/grep loop). Cleared after a turn that edits, so a legit post-edit
  // re-verification (`npx tsc --noEmit`) can run again.
  const commandHistory = new Map<string, number>();
  // Streak of consecutive all-blocked-repeat turns; escalation policy lives in blocked-repeat-guard.
  let consecutiveBlockedTurns = 0;
  const MAX_BLOCKED_TURNS = 2;
  // Streak of consecutive investigate-only turns (no edit/create); policy in no-produce-guard.
  let investigateOnlyTurns = 0;
  const PRODUCE = produceThresholds();

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
  // The in-memory file state for this turn — virtualFiles/diskCache maps plus the read/resolve/persist
  // helpers (extracted, Phase 2). The maps are mutated BY REFERENCE by the tool handlers below.
  const {
    virtualFiles,
    diskCache,
    toRel,
    resolveTarget,
    readDisk,
    currentContent,
    virtualEdits,
    persistToDisk,
  } = createVirtualFileTree(workspacePath);

  // Edit mode. DEFAULT `direct`: apply edits straight to disk (no per-edit sandbox); the model
  // self-verifies via run_command and REI runs ONE final verify. Lighter, avoids the reject-per-edit
  // loop that saturates local models, but leaves partial edits on abort (git-recoverable).
  // REI_EDIT_MODE=sandbox validates the cumulative tree per edit, persisting only green state (heavier).
  const directMode = process.env.REI_EDIT_MODE !== "sandbox";

  // Attaches the turn's aggregated token usage to a final result (no-op when none reported).
  const attachUsage = (r: ExecutionResult): ExecutionResult =>
    turnUsage ? { ...r, usage: turnUsage } : r;

  // Finalize with whatever was gathered (queued edits + one final verify); reused by turn-limit + loop-guard abandon.
  const finalizeAtLimit = () =>
    buildTurnLimitOutcome({
      loopCount,
      maxTurns: MAX_TURNS,
      workspacePath,
      directMode,
      logger,
      virtualEdits,
      firstTurnExplanation,
      appendCreatedSummary,
    }).then(attachUsage);

  while (loopCount < MAX_TURNS) {
    loopCount++;

    // One `step-N` span per loop iteration (global-active so llm-call/tool spans nest under it).
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

      // Aggregate backend-reported usage for the turn (no-op when the provider doesn't report it).
      if (result.usage) turnUsage = mergeTurnUsage(turnUsage, result.usage);

      // Truncated mid-output with no tool call yet — hit the output-token cap before acting.
      // Continue the partial output back into the loop (bounded) so its tool calls get processed,
      // or finish honestly once the continuation budget is exhausted.
      if (result.finishReason === "length" && result.toolCalls.length === 0) {
        const outcome = await handleTruncation({
          content: result.content,
          reasoning: result.reasoning,
          currentMessages,
          truncationContinuations,
          logger,
          emitStatus,
          virtualEdits,
          firstTurnExplanation,
          appendCreatedSummary,
        });
        if (outcome.action === "finalize") return attachUsage(outcome.result);
        currentMessages = outcome.messages;
        truncationContinuations = outcome.truncationContinuations;
        continue;
      }

      // NOTE: truncationContinuations is a TOTAL for the user-turn (NOT reset on productive turns).
      // Resetting it let over-thinking models loop (reason→truncate→continue→tool-call resets it→
      // repeat, burning thousands of tokens); capping the TOTAL (MAX_TRUNCATION_CONTINUATIONS) bounds it.

      // Capture text explanation from first turn
      if (loopCount === 1 && result.content.trim()) {
        firstTurnExplanation = result.content.trim();
      }

      // ── No tool calls ──────────────────────────────────────────────────────
      // Plain text: a faked-as-text tool call (nudge), a completion failing final verify (self-correct), or a genuine finish.
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
        if (outcome.action === "finalize") return attachUsage(outcome.result);
        currentMessages = outcome.messages;
        formatCorrections = outcome.formatCorrections;
        verifyRetries = outcome.verifyRetries;
        continue;
      }

      // ── Process tool calls ─────────────────────────────────────────────────
      // Record the assistant tool_calls in history; carry reasoning for REI_PRESERVE_THINKING re-send.
      currentMessages.push({
        role: "assistant",
        content: result.content,
        tool_calls: result.toolCalls,
        ...(result.reasoning ? { reasoning_content: result.reasoning } : {}),
      });

      // Execute every tool call (spans + arg-parse + dispatch). Edits are only QUEUED here, applied as a batch below.
      const createdBefore = createdFiles.length; // to detect a create_file this turn (produce-or-bail)
      let { hasToolFailure, editTasks, toolResultsMap, blockedRepeatCount } =
        await dispatchToolCalls(
        result.toolCalls,
        {
          workspacePath,
          mode,
          roleWriteGlob,
          logger,
          emitStatus,
          elicit,
          provider,
          mcpRegistry,
          toRel,
          currentContent,
          virtualFiles,
          allMcpTools,
          activeMcp,
          skills,
          resolveTarget,
          createdFiles,
          commandHistory,
        },
      );

      // A turn that queued edits changed (or will change) disk state — drop the run_command
      // history so a follow-up re-verification of the SAME command (e.g. `npx tsc --noEmit`)
      // isn't mistaken for a no-progress loop.
      if (editTasks.length > 0) commandHistory.clear();

      // Apply this turn's queued edits onto the CURRENT virtual tree (cumulative, per file & in order),
      // then validate the WHOLE tree — catches cross-file breakage while letting interdependent files be
      // fixed across turns. Search blocks match the content the model was shown (no already-edited poison).
      // Persists (direct) or validate-then-persists (sandbox); mutates maps by ref; returns failure/
      // escalation decisions (mismatch escalation is acted on AFTER tool results are fed back).
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
        readDisk,
        persistToDisk,
      });
      if (batch.failed) hasToolFailure = true;
      consecutiveSearchMismatchFailures = batch.mismatchStreak;
      const mismatchEscalation = batch.mismatchEscalation;

      // Feed back all tool results to model history in correct chronological order.
      //
      // This is the ONE point where a tool's bytes enter the model's context, so it is where the
      // context budget is enforced: anything over the inline limit is written to disk and replaced
      // by a receipt naming the path, the id and exactly how much was omitted. It used to be done
      // per-tool, in the MCP branch only — so `run_command` put a 24k build log into the window
      // while a 3k MCP fetch was spilled, and every tool added later inherited the wrong default.
      //
      // Spilling here also bounds the RE-SEND cost: results stay in `currentMessages` and go back
      // to the model on every subsequent call of the turn, so an unspilled 6k result is not paid
      // once, it is paid once per remaining step.
      for (const call of result.toolCalls) {
        const res =
          toolResultsMap.get(call.id) ?? "ERROR: Tool execution failed";
        currentMessages.push({
          role: "tool",
          content: spillExempt(call.function.name)
            ? res
            : retainAndMaybeSpill(call.function.name, res),
          tool_call_id: call.id,
          name: call.function.name,
        });
      }

      // Read the same file twice in a turn and the first copy is dead weight that still ships on
      // every remaining model call. Dropping it here — after the new results land, so the newest
      // copy is the one that survives — is the difference between paying for a file once and
      // paying for it once per step. Only exact duplicates go; see prune-superseded-reads.
      currentMessages = pruneSupersededReads(currentMessages);

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

      // Loop-guard: nudge (forceful STOP) → abandon (finalize) on a 2nd all-blocked turn. Policy in blocked-repeat-guard.
      const guard = evaluateBlockedRepeats({
        toolCallCount: result.toolCalls.length,
        blockedRepeatCount,
        consecutiveBlockedTurns,
        maxBlockedTurns: MAX_BLOCKED_TURNS,
      });
      consecutiveBlockedTurns = guard.consecutiveBlockedTurns;
      if (guard.action === "abandon") {
        logger.logInfo("[tools] loop-guard: abandoning — repeated blocked commands, no progress");
        emitStatus("⛔  [REI] Repeated-command loop with no progress — ending the turn.");
        return finalizeAtLimit();
      }
      if (guard.action === "nudge") {
        currentMessages.push({ role: "user", content: BLOCKED_REPEAT_STOP_MESSAGE });
      }

      // Produce-or-bail: investigation that never edits/creates is the "explore forever, output nothing" loop (varied cmds → blocked-repeat guard misses it).
      const produce = evaluateNoProduce({
        toolCallCount: result.toolCalls.length,
        producedDeliverable: editTasks.length > 0 || createdFiles.length > createdBefore,
        investigateOnlyTurns, ...PRODUCE,
      });
      investigateOnlyTurns = produce.investigateOnlyTurns;
      if (produce.action === "abandon") {
        emitStatus("⛔  [REI] Too much investigation without producing — wrapping up with what was gathered.");
        return finalizeAtLimit();
      } else if (produce.action === "nudge") {
        emitStatus("↩️  [REI] Lots of exploration without producing — asking it to deliver now.");
        currentMessages.push({ role: "user", content: PRODUCE_NOW_MESSAGE });
      }

      // Do NOT return on valid edits — keep looping so the model can edit more files; everything is
      // applied when it signals completion (a plain-text response, handled above). Reads/commands/
      // queued-edits/failures all just continue the loop.
    } finally {
      endStep();
    }
  }

  // Hit the turn limit without completion — apply queued edits (with one final verify) or report failure.
  return finalizeAtLimit();
}
