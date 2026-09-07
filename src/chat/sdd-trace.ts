/**
 * Deterministic traceability between a spec and the plan built from it.
 *
 * The SDD flow runs one way — spec → plan → implement → verify — so a discovery made while
 * implementing has no path back. The spec silently goes stale, and then `verify-against-spec` judges
 * the work against criteria that no longer describe it: abandoned-on-purpose criteria read as NOT
 * MET, and work the spec still excludes reads as an out-of-scope violation.
 *
 * This module answers the question with code rather than a model: cross the spec's numbered
 * acceptance criteria against the `Satisfies:` line every stage carries, in BOTH directions.
 *
 * - A stage naming AC-9 when the spec has 5 criteria → the plan moved ahead of the spec.
 * - A criterion no stage claims → the spec moved ahead of the plan (or the plan simply missed it).
 *
 * It reports; it never edits. Which of the two documents is wrong is a judgment call, and the point
 * is to make the disagreement visible instead of letting it surface as a bogus verification verdict.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { STAGE_REGEX } from "./plan-tracker.js";

export interface Criterion {
  /** The number as written in the spec's ordered list — the N in "AC-N". */
  id: number;
  text: string;
}

export interface StageRef {
  stage: number;
  title: string;
  /** The raw `Satisfies:` value, or undefined when the stage carries no such line. */
  satisfies?: string;
  /** Criterion numbers named in `satisfies` — empty when it names an in-scope item instead. */
  acRefs: number[];
}

export interface TraceReport {
  criteria: Criterion[];
  stages: StageRef[];
  /** Criteria no stage names. The spec asks for something the plan does not build. */
  uncovered: Criterion[];
  /** Stages naming a criterion the spec does not have. Includes the bad ids for the message. */
  orphans: Array<{ stage: StageRef; missing: number[] }>;
  /** Stages with no `Satisfies:` line at all — required by the recipe when a spec is present. */
  untraced: StageRef[];
  /** Stages whose `Satisfies:` names a scope item, not an AC number: real, but not cross-checkable. */
  freeform: StageRef[];
}

/** Headings that open the acceptance-criteria block, in either language the recipes are written in. */
const CRITERIA_HEADING = /^#{1,6}\s*(?:acceptance\s+criteria|criterios?\s+de\s+aceptaci[oó]n)\b/i;
const ANY_HEADING = /^#{1,6}\s/;
const NUMBERED_ITEM = /^\s*(\d+)[.)]\s+(.*)$/;
const SATISFIES_LINE = /^\s*(?:[-*]\s*)?(?:\*\*)?satisfa?(?:ce|ies|ies:)?\w*\s*:?\s*\**\s*:?\s*(.*)$/i;

/**
 * Criterion references inside a `Satisfies:` value: "AC-2", "AC 2", "AC2", "criterion 2",
 * "criterio 2". A bare number is deliberately NOT a reference — "Satisfies: 2 of the in-scope
 * bullets" would otherwise read as criterion 2.
 */
const AC_REF = /(?:\bac\b[\s-]*|criteri(?:on|o)\s+)(\d+)/gi;

/** Pulls the numbered acceptance criteria out of a spec. Returns [] when the section is absent. */
export function parseCriteria(specText: string): Criterion[] {
  const lines = specText.split("\n");
  const start = lines.findIndex((l) => CRITERIA_HEADING.test(l));
  if (start === -1) return [];

  const out: Criterion[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (ANY_HEADING.test(line)) break; // next section ends the block
    const m = line.match(NUMBERED_ITEM);
    if (m) out.push({ id: Number(m[1]), text: m[2].trim() });
  }
  return out;
}

/** Reads every stage and the criteria its `Satisfies:` line names. */
export function parseStages(planText: string): StageRef[] {
  const lines = planText.split("\n");
  const stages: StageRef[] = [];

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(STAGE_REGEX);
    if (!m) continue;
    // STAGE_REGEX has two alternative `(#+)` groups, so the number is group 3 and the rest of the
    // heading group 4 — the leading ":" or "." of "## Stage 1: title" / "## 3. title" is dropped.
    const stage: StageRef = {
      stage: Number(m[3]),
      title: (m[4] ?? "").replace(/^[:.\s-]+/, "").trim(),
      acRefs: [],
    };

    // Scan the stage body for its Satisfies line, stopping at the next stage.
    for (let j = i + 1; j < lines.length && !STAGE_REGEX.test(lines[j]); j++) {
      const s = lines[j].match(SATISFIES_LINE);
      if (!s) continue;
      const value = s[1].trim();
      stage.satisfies = value;
      stage.acRefs = [...value.matchAll(AC_REF)].map((r) => Number(r[1]));
      break;
    }
    stages.push(stage);
  }
  return stages;
}

/** Crosses spec against plan in both directions. Pure: no file access, no model. */
export function traceSpecToPlan(specText: string, planText: string): TraceReport {
  const criteria = parseCriteria(specText);
  const stages = parseStages(planText);
  const known = new Set(criteria.map((c) => c.id));
  const claimed = new Set(stages.flatMap((s) => s.acRefs));

  return {
    criteria,
    stages,
    uncovered: criteria.filter((c) => !claimed.has(c.id)),
    orphans: stages
      .map((stage) => ({ stage, missing: stage.acRefs.filter((r) => !known.has(r)) }))
      .filter((o) => o.missing.length > 0),
    untraced: stages.filter((s) => s.satisfies === undefined),
    freeform: stages.filter((s) => s.satisfies !== undefined && s.acRefs.length === 0),
  };
}

/** Renders the report for the terminal. Says what it could not check, not only what it found. */
export function formatTraceReport(
  report: TraceReport,
  specName: string,
  planName: string,
): string {
  const { criteria, stages, uncovered, orphans, untraced, freeform } = report;
  const out: string[] = [
    `[TRACE] .rei/specs/${specName}.md ↔ .rei/plans/${planName}.md`,
    `  ${criteria.length} acceptance criteria · ${stages.length} stages`,
  ];

  if (criteria.length === 0) {
    out.push(
      "",
      "  ⚠ The spec has no numbered acceptance criteria, so there is nothing to trace against.",
      '    They must be a numbered list under "## Acceptance criteria".',
    );
    return out.join("\n");
  }

  if (orphans.length > 0) {
    out.push("", "  ✖ Stages naming a criterion the spec does not have — the PLAN moved ahead:");
    for (const { stage, missing } of orphans) {
      out.push(`      Stage ${stage.stage}: ${stage.title}`);
      out.push(`        names ${missing.map((n) => `AC-${n}`).join(", ")}`);
    }
  }

  if (uncovered.length > 0) {
    out.push("", "  ✖ Criteria no stage claims — the SPEC moved ahead, or the plan misses them:");
    for (const c of uncovered) {
      out.push(`      AC-${c.id}: ${c.text.slice(0, 68)}${c.text.length > 68 ? "…" : ""}`);
    }
  }

  if (untraced.length > 0) {
    out.push("", "  ⚠ Stages with no `Satisfies:` line (the recipe requires one when a spec exists):");
    for (const s of untraced) out.push(`      Stage ${s.stage}: ${s.title}`);
  }

  if (freeform.length > 0) {
    out.push(
      "",
      "  · Stages tracing to an in-scope item rather than an AC number — real, but not checkable here:",
    );
    for (const s of freeform) {
      out.push(`      Stage ${s.stage} → "${(s.satisfies ?? "").slice(0, 56)}"`);
    }
  }

  const broken = orphans.length + uncovered.length;
  out.push(
    "",
    broken === 0
      ? "  ✔ Spec and plan agree on every criterion that could be checked."
      : `  ${broken} disagreement(s). Update whichever document is now wrong — and if the design ` +
        `changed, say so in the spec so verification is not graded against a rewritten contract.`,
  );
  if (freeform.length > 0 || untraced.length > 0) {
    out.push(
      `  Coverage checked for ${stages.length - freeform.length - untraced.length} of ${stages.length} stages.`,
    );
  }
  return out.join("\n");
}


// ── Scope inventory ────────────────────────────────────────────────────────────────────────────
//
// A plan opens with the files it intends to touch, declared BEFORE the stages. That ordering is the
// point: a model conditions each token on the ones it already wrote, so an inventory it emits first
// stays in its immediate context while it builds the plan — which is what stops a stage from being
// quietly dropped in a medium-sized plan.
//
// The risk is the same mechanism running backwards. An inventory written from imagination anchors
// the whole plan to files that do not exist, turning one wrong step into a coherent wrong plan. So
// the declaration is CHECKED rather than trusted: against disk, and against the stages themselves.

/** The `Files to modify:` block that opens a plan, before any stage. */
const SCOPE_FILES = /^\s*(?:[-*]\s*)?(?:\*\*)?files\s+to\s+modify(?:\*\*)?\s*:\s*(.*)$/im;

export interface ScopeReport {
  /** Paths the plan declared up front. */
  declared: string[];
  /** Declared paths with no file on disk — the inventory is imagined, not grounded. */
  missing: string[];
  /** Declared but never touched by any stage — scope claimed and then dropped. */
  unplanned: string[];
  /** Touched by a stage but never declared — the inventory is incomplete. */
  undeclared: string[];
}

/** Reads the up-front inventory. Only the block BEFORE the first stage counts. */
export function parseDeclaredScope(planContent: string): string[] {
  const firstStage = planContent.split("\n").findIndex((l) => STAGE_REGEX.test(l));
  const head = firstStage === -1 ? planContent : planContent.split("\n").slice(0, firstStage).join("\n");
  const raw = head.match(SCOPE_FILES)?.[1] ?? "";
  return raw
    .split(/[,\s]+/)
    .map((f) => f.trim().replace(/[`,]/g, ""))
    .filter((f) => f.length > 0 && f !== "none" && f.includes("."));
}

/** Crosses the declared inventory against disk and against what the stages actually touch. */
export function checkScope(planContent: string, workspacePath: string): ScopeReport {
  const declared = parseDeclaredScope(planContent);
  const touched = new Set(splitPlanIntoStageFiles(planContent));
  const declaredSet = new Set(declared);
  return {
    declared,
    missing: declared.filter((f) => !fs.existsSync(path.join(workspacePath, f))),
    unplanned: declared.filter((f) => !touched.has(f)),
    undeclared: [...touched].filter((f) => !declaredSet.has(f)),
  };
}

/** Every path named by a stage's own `Files to modify:` line. */
function splitPlanIntoStageFiles(planContent: string): string[] {
  const lines = planContent.split("\n");
  const firstStage = lines.findIndex((l) => STAGE_REGEX.test(l));
  if (firstStage === -1) return [];
  const out: string[] = [];
  for (const line of lines.slice(firstStage)) {
    const m = line.match(SCOPE_FILES);
    if (!m) continue;
    for (const f of m[1].split(/[,\s]+/)) {
      const clean = f.trim().replace(/[`,]/g, "");
      if (clean && clean !== "none" && clean.includes(".")) out.push(clean);
    }
  }
  return out;
}

/** Renders the scope check, saying what it could NOT check as well as what it found. */
export function formatScopeReport(r: ScopeReport): string {
  if (r.declared.length === 0) {
    return (
      "  · No up-front `Files to modify:` block — the plan goes straight to its stages.\n" +
      "    Declaring the scope first is what keeps a stage from being dropped; see the\n" +
      "    micro-task-decomposition skill."
    );
  }
  const out: string[] = [`  ${r.declared.length} file(s) declared up front`];
  if (r.missing.length > 0) {
    out.push("", "  ✖ Declared but NOT on disk — the inventory was imagined, not read:");
    for (const f of r.missing) out.push(`      ${f}`);
  }
  if (r.unplanned.length > 0) {
    out.push("", "  ✖ Declared but no stage touches them — scope claimed, then dropped:");
    for (const f of r.unplanned) out.push(`      ${f}`);
  }
  if (r.undeclared.length > 0) {
    out.push("", "  ⚠ Touched by a stage but never declared — the inventory is incomplete:");
    for (const f of r.undeclared) out.push(`      ${f}`);
  }
  if (r.missing.length + r.unplanned.length + r.undeclared.length === 0) {
    out.push("  ✔ Every declared file exists and is covered by a stage.");
  }
  return out.join("\n");
}
