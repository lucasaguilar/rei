/**
 * Executing a plan one stage at a time, each in an isolated sub-agent.
 *
 * Running every stage in the main session means stage 8 reasons with stages 1–7's entire
 * exploration in context — every file read, every tool result, every diff — which is both large and
 * mostly irrelevant to the change at hand. A plan stage is already the self-contained unit
 * `delegate` asks for: `micro-task-decomposition` enforces one change per stage, full relative
 * paths, and a concrete `Verify:` command. So REI delegates each stage deterministically instead of
 * hoping the model chooses to.
 *
 * Two things are deliberately NOT delegated:
 * - **Report stages** (`Skill: verify-against-spec`). Their contract is to judge the whole change
 *   against the spec, which a clean-context worker cannot see. They stay on the normal path.
 * - **Dependencies.** A worker starting fresh does not know what an earlier stage decided, so the
 *   summaries of the stages a stage `Depends on:` are passed into its task.
 */
import { STAGE_REGEX } from "../chat/plan-tracker.js";
import { buildFileMatcherRegex } from "../language/language-capabilities.js";

/** Stages whose product is a report, not edits — see plan-commands' REPORT_DIRECTIVE. */
const REPORT_ONLY_SKILLS = ["verify-against-spec"];

export interface PlanStage {
  num: number;
  /** The heading line, trimmed of its markers. */
  title: string;
  /** The full stage text, heading included — what gets handed to the worker. */
  body: string;
  /** Workspace paths named in the stage, minus REI's own artifacts. */
  files: string[];
  /** True when the stage produces a report; such a stage is never delegated. */
  isReport: boolean;
  /** Stage numbers named on a `Depends on:` line. */
  dependsOn: number[];
}

const DEPENDS_ON = /^\s*(?:[-*]\s*)?(?:\*\*)?depends\s*on(?:\*\*)?\s*:\s*(.*)$/im;

/** Splits a plan into its stages, using the same headings `/runplan` executes. */
export function splitPlanIntoStages(planContent: string): PlanStage[] {
  const lines = planContent.split("\n");
  const heads: Array<{ i: number; num: number; level: number; title: string }> = [];

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(STAGE_REGEX);
    if (!m) continue;
    heads.push({
      i,
      num: Number(m[3]),
      level: (m[1] ?? m[2] ?? "").length,
      title: (m[4] ?? "").replace(/^[:.\s-]+/, "").trim(),
    });
  }

  const fileRegex = buildFileMatcherRegex();
  return heads.map((h, k) => {
    // The stage ends at the next stage heading, or at a heading of the same/higher level — the same
    // rule /runplan already uses to carve out a single stage.
    let end = lines.length;
    for (let i = h.i + 1; i < lines.length; i++) {
      const line = lines[i];
      if (!line.startsWith("#")) continue;
      const isStage = STAGE_REGEX.test(line);
      const level = (line.match(/^#+/) ?? [""])[0].length;
      if (isStage || level <= h.level) {
        end = i;
        break;
      }
    }
    if (k + 1 < heads.length) end = Math.min(end, heads[k + 1].i);

    const body = lines.slice(h.i, end).join("\n");
    // REI's own artifacts are never a target: a plan that states where it was saved would otherwise
    // turn its own path into a "file to modify".
    const files = Array.from(new Set(body.match(fileRegex) ?? [])).filter(
      (f) => !/(^|\/)\.?rei\//i.test(f),
    );
    const dep = body.match(DEPENDS_ON)?.[1] ?? "";
    return {
      num: h.num,
      title: h.title,
      body,
      files,
      isReport: REPORT_ONLY_SKILLS.some((s) =>
        new RegExp(`^\\s*Skill:.*\\b${s}\\b`, "im").test(body),
      ),
      dependsOn: [...dep.matchAll(/\d+/g)].map((m) => Number(m[0])),
    };
  });
}

/** The stages that get delegated, in order: everything up to the first report stage. */
export function delegableStages(stages: PlanStage[]): PlanStage[] {
  const firstReport = stages.findIndex((s) => s.isReport);
  return firstReport === -1 ? stages : stages.slice(0, firstReport);
}

/**
 * Builds the task text for one worker. It starts fresh, so everything it needs is spelled out:
 * the stage, the summaries of the stages it depends on, and an explicit "this is execution".
 */
export function buildStageTask(
  stage: PlanStage,
  summaries: ReadonlyMap<number, string>,
): string {
  const deps = stage.dependsOn
    .map((n) => (summaries.has(n) ? `  - Stage ${n}: ${summaries.get(n)}` : null))
    .filter(Boolean);

  return (
    `Execute Stage ${stage.num} of an implementation plan. This is EXECUTION, not planning: ` +
    `make the actual edits, then run the stage's Verify command.\n\n` +
    `${stage.body}\n` +
    (deps.length > 0
      ? `\nWhat the stages this one depends on already did (you cannot see their work otherwise):\n${deps.join("\n")}\n`
      : "")
  );
}

export interface StageOutcome {
  stage: number;
  title: string;
  summary: string;
  failed: boolean;
}

export interface DelegateRunner {
  (task: string, files: string[]): Promise<string>;
}

/**
 * Runs the delegable stages in order, threading each summary forward. Sequential by necessity:
 * stages can depend on each other, and they share one local model anyway.
 *
 * A failing stage stops the run — continuing would build later stages on a broken base, and the
 * summary of what failed is more useful than a pile of cascading errors.
 */
export async function runStagesViaSubAgents(
  stages: PlanStage[],
  runner: DelegateRunner,
  onStatus?: (msg: string) => void,
): Promise<StageOutcome[]> {
  const summaries = new Map<number, string>();
  const outcomes: StageOutcome[] = [];

  for (const stage of stages) {
    onStatus?.(`🤖  [REI] Stage ${stage.num}/${stages.length} → sub-agent: ${stage.title}`);
    try {
      const summary = await runner(buildStageTask(stage, summaries), stage.files);
      summaries.set(stage.num, summary);
      outcomes.push({ stage: stage.num, title: stage.title, summary, failed: false });
      onStatus?.(`   ↳ stage ${stage.num} done.`);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      outcomes.push({ stage: stage.num, title: stage.title, summary: detail, failed: true });
      onStatus?.(`   ↳ stage ${stage.num} FAILED: ${detail}`);
      break;
    }
  }
  return outcomes;
}

/** Renders the run for the user: what each stage did, and where it stopped if it did. */
export function formatDelegationReport(
  outcomes: StageOutcome[],
  total: number,
  reportStagePending?: number,
): string {
  const out: string[] = [];
  for (const o of outcomes) {
    out.push(`  ${o.failed ? "✖" : "✔"} Stage ${o.stage}: ${o.title}`);
    for (const line of o.summary.split("\n")) out.push(`      ${line}`);
  }
  const failed = outcomes.find((o) => o.failed);
  out.unshift(
    failed
      ? `[RUNPLAN] Stopped at stage ${failed.stage} of ${total} — later stages would build on a broken base.`
      : `[RUNPLAN] ${outcomes.length} of ${total} stage(s) executed in isolated sub-agents.`,
  );
  if (!failed && reportStagePending !== undefined) {
    out.push(
      "",
      `  Stage ${reportStagePending} produces a report and is NOT delegated — judging the whole ` +
        `change against the spec needs context a fresh worker does not have. Running it here.`,
    );
  }
  return out.join("\n");
}
