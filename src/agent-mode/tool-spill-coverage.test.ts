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
 * The loop appends; it never edits what it already sent.
 *
 * A pruner used to empty the earlier copy of a file read twice in one turn. It saved tokens and
 * rewrote a message the backend had already processed — and a local runtime reuses its KV cache
 * only while the next prompt extends the last, so everything after the gutted message was re-read.
 * On a real turn that cost 28s, against ~11s paid ONCE for keeping the duplicate.
 */
describe("the loop only appends to its message list", () => {
  it("does not prune superseded reads", () => {
    expect(GENERATOR).not.toContain("pruneSupersededReads");
  });

  it("assigns currentMessages only where the loop legitimately re-seats it", () => {
    // Truncation/format-correction hand back the SAME array extended; anything else reassigning it
    // is a rewrite in disguise, which is what this file exists to keep out.
    const assignments = [...GENERATOR.matchAll(/currentMessages = (\w+)/g)].map((m) => m[1]);
    expect(new Set(assignments)).toEqual(new Set(["outcome"]));
  });
});
