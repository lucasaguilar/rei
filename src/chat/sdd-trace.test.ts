import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import {
  parseCriteria,
  parseStages,
  traceSpecToPlan,
  formatTraceReport,
  checkScope,
  parseDeclaredScope,
  formatScopeReport,
} from "./sdd-trace.js";

const SPEC = `# Spec: login

## Goal
Let a user sign in.

## In scope
- The login form.

## Out of scope (non-goals)
- Password reset.

## Acceptance criteria
1. A valid user reaches the dashboard.
2. An invalid password shows an error.
3. The session survives a reload.

## Constraints
- No new dependencies.
`;

const PLAN = `# Plan: login

## Stage 1: Add the form component
Files to modify: src/login.ts
Satisfies: AC-1
Verify: tsc --noEmit

## Stage 2: Reject bad passwords
Files to modify: src/auth.ts
Satisfies: AC-2
Verify: tsc --noEmit

## Stage 3: Persist the session
Files to modify: src/session.ts
Satisfies: AC-3
Verify: tsc --noEmit
`;

describe("parseCriteria", () => {
  it("reads the numbered list under the acceptance-criteria heading only", () => {
    const criteria = parseCriteria(SPEC);
    expect(criteria.map((c) => c.id)).toEqual([1, 2, 3]);
    expect(criteria[1].text).toBe("An invalid password shows an error.");
  });

  it("stops at the next heading so later numbered lists are not criteria", () => {
    expect(parseCriteria(SPEC).some((c) => c.text.includes("dependencies"))).toBe(false);
  });

  it("accepts the Spanish heading the recipes also produce", () => {
    const es = "## Criterios de aceptación\n1. El usuario entra.\n2. Falla con clave mala.\n";
    expect(parseCriteria(es).map((c) => c.id)).toEqual([1, 2]);
  });

  it("returns nothing when the spec has no criteria section", () => {
    expect(parseCriteria("# Spec\n\n## Goal\nAlgo.\n")).toEqual([]);
  });
});

describe("parseStages", () => {
  it("pairs each stage with the criteria its Satisfies line names", () => {
    const stages = parseStages(PLAN);
    expect(stages.map((s) => s.stage)).toEqual([1, 2, 3]);
    expect(stages[0].title).toBe("Add the form component");
    expect(stages.map((s) => s.acRefs)).toEqual([[1], [2], [3]]);
  });

  it("reads several criteria from one line, in the spellings the recipes use", () => {
    const plan = "## Stage 1: x\nSatisfies: AC-1, AC 4 and criterion 7\n";
    expect(parseStages(plan)[0].acRefs).toEqual([1, 4, 7]);
  });

  it("does not read a bare number as a criterion reference", () => {
    // "Satisfies: 2 of the in-scope bullets" must not be mistaken for criterion 2.
    const plan = "## Stage 1: x\nSatisfies: 2 of the in-scope bullets\n";
    const [stage] = parseStages(plan);
    expect(stage.acRefs).toEqual([]);
    expect(stage.satisfies).toBe("2 of the in-scope bullets");
  });

  it("marks a stage with no Satisfies line as untraced, not as satisfying nothing", () => {
    const plan = "## Stage 1: x\nFiles to modify: a.ts\nVerify: tsc\n";
    expect(parseStages(plan)[0].satisfies).toBeUndefined();
  });
});

describe("traceSpecToPlan", () => {
  it("reports agreement when every criterion has a stage and every stage a criterion", () => {
    const r = traceSpecToPlan(SPEC, PLAN);
    expect(r.uncovered).toEqual([]);
    expect(r.orphans).toEqual([]);
    expect(r.untraced).toEqual([]);
  });

  it("flags a criterion no stage claims — the spec moved ahead of the plan", () => {
    // Exactly the drift the flow cannot otherwise see: a criterion added (or kept) after the plan
    // was built, which verify-against-spec would later report as NOT MET with no explanation.
    const plan = PLAN.replace(/## Stage 3[\s\S]*$/, "");
    const r = traceSpecToPlan(SPEC, plan);
    expect(r.uncovered.map((c) => c.id)).toEqual([3]);
    expect(r.orphans).toEqual([]);
  });

  it("flags a stage naming a criterion the spec does not have — the plan moved ahead", () => {
    const plan = PLAN + "\n## Stage 4: Add SSO\nSatisfies: AC-9\n";
    const r = traceSpecToPlan(SPEC, plan);
    expect(r.orphans).toHaveLength(1);
    expect(r.orphans[0].stage.stage).toBe(4);
    expect(r.orphans[0].missing).toEqual([9]);
  });

  it("separates a scope-item reference from a missing one", () => {
    const plan = PLAN + '\n## Stage 4: Wire the form\nSatisfies: the login form in-scope bullet\n';
    const r = traceSpecToPlan(SPEC, plan);
    expect(r.freeform.map((s) => s.stage)).toEqual([4]);
    expect(r.orphans).toEqual([]); // naming a scope item is legitimate, just not checkable
  });
});

describe("formatTraceReport", () => {
  it("says both documents agree when they do", () => {
    const out = formatTraceReport(traceSpecToPlan(SPEC, PLAN), "login", "login");
    expect(out).toContain("3 acceptance criteria · 3 stages");
    expect(out).toContain("Spec and plan agree");
  });

  it("names the drifting criterion and which direction it drifted", () => {
    const plan = PLAN.replace(/## Stage 3[\s\S]*$/, "");
    const out = formatTraceReport(traceSpecToPlan(SPEC, plan), "login", "login");
    expect(out).toContain("AC-3");
    expect(out).toContain("the SPEC moved ahead");
  });

  it("says plainly when there is nothing to trace against", () => {
    const out = formatTraceReport(traceSpecToPlan("# Spec\n## Goal\nx\n", PLAN), "s", "p");
    expect(out).toContain("no numbered acceptance criteria");
  });

  it("reports how many stages could actually be checked", () => {
    const plan = PLAN + "\n## Stage 4: Wire it\nSatisfies: the in-scope form bullet\n";
    const out = formatTraceReport(traceSpecToPlan(SPEC, plan), "login", "login");
    expect(out).toContain("Coverage checked for 3 of 4 stages");
  });
});

// ── Scope inventory ────────────────────────────────────────────────────────────────────────────

/**
 * A plan declares the files it will touch BEFORE its stages, so the list stays in the model's own
 * context while it writes them. The same mechanism runs backwards when the list is imagined: the
 * plan is then coherently built on files that do not exist. So the declaration is checked, never
 * trusted — against disk, and against the stages themselves.
 */
const PLAN_WITH_SCOPE = `# Plan: login

## Scope
Files to modify: src/auth.ts, src/session.ts
Affected consumers: none — checked with grep_code
Breaking changes: none

## Stage 1: Reject bad passwords
Files to modify: src/auth.ts
Verify: tsc --noEmit

## Stage 2: Persist the session
Files to modify: src/session.ts
Verify: tsc --noEmit
`;

let sws: string;
const touch = (rel: string) => {
  const f = join(sws, rel);
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, "export const x = 1;\n");
};

describe("parseDeclaredScope", () => {
  it("reads only the block BEFORE the first stage", () => {
    // A stage's own `Files to modify:` is not the up-front declaration.
    expect(parseDeclaredScope(PLAN_WITH_SCOPE)).toEqual(["src/auth.ts", "src/session.ts"]);
  });

  it("returns nothing when the plan declares no scope", () => {
    expect(parseDeclaredScope("# Plan\n\n## Stage 1: x\nFiles to modify: a.ts\n")).toEqual([]);
  });
});

describe("checkScope", () => {
  beforeEach(() => {
    sws = mkdtempSync(join(tmpdir(), "rei-scope-"));
  });
  afterEach(() => rmSync(sws, { recursive: true, force: true }));

  it("passes when every declared file exists and a stage touches it", () => {
    touch("src/auth.ts");
    touch("src/session.ts");
    const r = checkScope(PLAN_WITH_SCOPE, sws);
    expect(r.missing).toEqual([]);
    expect(r.unplanned).toEqual([]);
    expect(r.undeclared).toEqual([]);
  });

  it("catches a file the model imagined — the failure mode this exists for", () => {
    touch("src/auth.ts"); // src/session.ts is never created
    expect(checkScope(PLAN_WITH_SCOPE, sws).missing).toEqual(["src/session.ts"]);
  });

  it("catches scope declared and then dropped", () => {
    touch("src/auth.ts");
    touch("src/session.ts");
    const plan = PLAN_WITH_SCOPE.replace(/## Stage 2[\s\S]*$/, "");
    expect(checkScope(plan, sws).unplanned).toEqual(["src/session.ts"]);
  });

  it("catches a stage touching a file the scope never declared", () => {
    touch("src/auth.ts");
    touch("src/session.ts");
    const plan = PLAN_WITH_SCOPE + "\n## Stage 3: Tidy\nFiles to modify: src/extra.ts\n";
    expect(checkScope(plan, sws).undeclared).toEqual(["src/extra.ts"]);
  });
});

describe("formatScopeReport", () => {
  it("says plainly when a plan declared no scope at all", () => {
    const out = formatScopeReport({ declared: [], missing: [], unplanned: [], undeclared: [] });
    expect(out).toContain("No up-front");
  });

  it("names an imagined file as not read, rather than merely missing", () => {
    const out = formatScopeReport({
      declared: ["a.ts"], missing: ["a.ts"], unplanned: [], undeclared: [],
    });
    expect(out).toContain("imagined, not read");
  });
});
