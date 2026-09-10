import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Every tool's output passes the context budget on its way into the model's history.
 *
 * It used to be enforced per-tool, at ONE call site inside the MCP branch. So a 3k MCP fetch was
 * spilled to disk while a 24k `run_command` build log went into the window whole — and every tool
 * added afterwards inherited the wrong default, silently.
 *
 * The cost is not paid once. Tool results stay in `currentMessages` and are re-sent on every
 * remaining model call of the turn, so an unspilled 6k result costs 6k per step, not 6k. Four
 * tools into a request that is most of a 50k window.
 *
 * These are source-level checks because the alternative — driving a whole turn — would not tell
 * you WHERE the budget stopped being applied.
 */
const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, rel), "utf-8");
const GENERATOR = read("generator-tools.ts");
const DISPATCH = read("tools-loop/dispatch-tool-calls.ts");

describe("the context budget is enforced at one place", () => {
  it("spills where tool results enter the model's history", () => {
    const feedback = GENERATOR.slice(GENERATOR.indexOf('role: "tool"') - 400);
    expect(feedback).toContain("retainAndMaybeSpill(call.function.name, res)");
  });

  it("no longer spills per-tool inside the dispatcher", () => {
    // Two enforcement points is how one of them falls behind.
    expect(DISPATCH).not.toContain("retainAndMaybeSpill");
  });

  it("exempts by name, so a tool added tomorrow is covered by default", () => {
    // An allow-list would have to be edited for every new tool — which is exactly what failed.
    expect(GENERATOR).toMatch(/const SPILL_EXEMPT = new Set\(/);
    expect(GENERATOR).toContain("spillExempt(call.function.name)");
  });

  it("keeps the exemption list short and deliberate", () => {
    const list = GENERATOR.match(/const SPILL_EXEMPT = new Set\(\[([\s\S]*?)\]\)/)?.[1] ?? "";
    const names = [...list.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(names).toContain("read_files"); // already paged with an explicit offset/limit
    expect(names).toContain("use_skill"); // a recipe only works whole
    expect(names.length).toBeLessThanOrEqual(6);
  });

  it("does not exempt the tools whose output is unbounded", () => {
    const list = GENERATOR.match(/const SPILL_EXEMPT = new Set\(\[([\s\S]*?)\]\)/)?.[1] ?? "";
    for (const tool of ["run_command", "grep_code", "list_files", "git_changes", "web_search"]) {
      expect(list, `${tool} must not be exempt — its output has no natural bound`).not.toContain(tool);
    }
  });
});

/**
 * The pruner has to run AFTER the new tool results are appended, or the copy it keeps is the old
 * one and the fresh read is the one thrown away — the exact inversion of what it is for.
 */
describe("superseded reads are pruned inside the turn", () => {
  it("runs the pruner in the loop", () => {
    expect(GENERATOR).toContain("currentMessages = pruneSupersededReads(currentMessages)");
  });

  it("runs it after the results are appended, not before", () => {
    const append = GENERATOR.indexOf('role: "tool"');
    const prune = GENERATOR.indexOf("pruneSupersededReads(currentMessages)");
    expect(append).toBeGreaterThan(-1);
    expect(prune).toBeGreaterThan(append);
  });
});
