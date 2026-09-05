import type { CommandContext, CommandResult } from "./command-handler.js";
import type { SessionMode } from "../types.js";
import { saveSession } from "../session-store.js";
import { AgentLogger } from "../../core/logger.js";
import { runSubAgent } from "../../agent-mode/sub-agent-runner.js";
import { runplanDelegationEnabled } from "../../config/model-runtime.js";
import {
  splitPlanIntoStages,
  delegableStages,
  runStagesViaSubAgents,
  formatDelegationReport,
} from "../../agent-mode/plan-delegation.js";

export interface DelegateStagesParams {
  planContent: string;
  /** The stage the user asked for, or null for the whole plan. */
  stageNum: number | null;
  /** The "Plan source: …" banner /runplan already built — kept above the delegation report. */
  planHeader: string;
  /** Passed in rather than re-declared, so both paths use the identical directive. */
  reportDirective: string;
}

/**
 * Runs a plan's stages through isolated sub-agents, one per stage.
 *
 * Returns `null` when the plan should execute the ordinary single-session way — delegation off, no
 * provider to delegate to, or nothing delegable (a plan with no parsable stages, or a lone report
 * stage). The caller then continues unchanged, which is what keeps this additive.
 */
export async function tryDelegateStages(
  ctx: CommandContext,
  { planContent, stageNum, planHeader, reportDirective }: DelegateStagesParams,
): Promise<CommandResult | null> {
  // `ctx.provider` is a real precondition, not a test accommodation: there is nothing to delegate
  // to without one. Callers that only exercise plan ROUTING (which plan, which stage) pass none and
  // keep the single-session path.
  if (!runplanDelegationEnabled() || !ctx.provider) return null;

  const { session, workspacePath } = ctx;
  const all = splitPlanIntoStages(planContent);
  const targets = stageNum !== null ? all.filter((s) => s.num === stageNum) : delegableStages(all);
  // A report stage falls through to the normal turn — it judges the whole change against the spec,
  // which a clean-context worker cannot see.
  const toRun = targets.filter((s) => !s.isReport);
  if (toRun.length === 0) return null;

  const logger = new AgentLogger(workspacePath);
  const outcomes = await runStagesViaSubAgents(
    toRun,
    (task, files) =>
      runSubAgent({
        task,
        files,
        provider: ctx.provider,
        workspacePath,
        logger,
        mcpRegistry: ctx.mcpRegistry,
        emitStatus: ctx.onStatus,
        // Without this the sub-agent's destructive-command gate never fires.
        elicit: ctx.elicit,
      }),
    ctx.onStatus,
  );

  const failed = outcomes.some((o) => o.failed);
  const pendingReport = stageNum === null ? all.find((s) => s.isReport) : undefined;
  const response =
    `${planHeader}\n` +
    formatDelegationReport(outcomes, toRun.length, failed ? undefined : pendingReport?.num);

  // The report stage runs in the session, with the stage summaries already on screen above it.
  if (!failed && pendingReport) {
    const agentMode = "agent" as SessionMode;
    saveSession(workspacePath, session.messages, agentMode, session.summary, session.createdAt);
    return {
      success: true,
      response,
      newSession: { ...session, mode: agentMode },
      autoExecute: {
        prompt:
          `[RUNPLAN STAGE ${pendingReport.num}] Execute Stage ${pendingReport.num} of the ` +
          `implementation plan.\n\nSUB-PLAN:\n${pendingReport.body}` + reportDirective,
      },
    };
  }
  return { success: !failed, response, recordInSession: false };
}
