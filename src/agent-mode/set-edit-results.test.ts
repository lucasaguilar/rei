import { describe, it, expect } from "vitest";
import { setEditResults } from "./generator-tools.js";
import type { AgentSREdit } from "../contracts/agent-interaction.types.js";

const task = (callId: string, file: string): { callId: string; edit: AgentSREdit } => ({
  callId,
  edit: { file, search: "", replace: "" },
});

describe("setEditResults (kills read-after-edit churn)", () => {
  it("inlines the updated file content and tells the model NOT to re-read", () => {
    const candidate = new Map([["a.scss", ".x { color: red; }"]]);
    const results = new Map<string, string>();
    const provided = new Map<string, string>();

    setEditResults([task("c1", "a.scss")], candidate, results, provided);

    const r = results.get("c1")!;
    expect(r).toContain(".x { color: red; }"); // updated content inlined
    expect(r).toMatch(/do NOT call read_files/i);
    // alreadyProvided refreshed so a later re-read is deduped to "unchanged since shown".
    expect(provided.get("a.scss")).toBe(".x { color: red; }");
  });

  it("inlines a file's content once per batch; repeats point to it", () => {
    const candidate = new Map([["a.scss", "FINAL"]]);
    const results = new Map<string, string>();
    const provided = new Map<string, string>();

    setEditResults(
      [task("c1", "a.scss"), task("c2", "a.scss")],
      candidate,
      results,
      provided,
    );

    expect(results.get("c1")).toContain("FINAL"); // first inlines
    expect(results.get("c2")).toContain("shown above"); // second references it
    expect(results.get("c2")).not.toContain("FINAL");
  });

  it("does NOT inline oversized files and leaves alreadyProvided stale", () => {
    const big = "x".repeat(30000);
    const candidate = new Map([["big.ts", big]]);
    const results = new Map<string, string>();
    const provided = new Map<string, string>();

    setEditResults([task("c1", "big.ts")], candidate, results, provided);

    const r = results.get("c1")!;
    expect(r).not.toContain(big); // not inlined
    expect(r).toMatch(/large/i);
    expect(provided.has("big.ts")).toBe(false); // model never saw new content → don't dedup
  });

  it("handles multiple distinct files in one batch", () => {
    const candidate = new Map([
      ["a.scss", "AAA"],
      ["b.html", "BBB"],
    ]);
    const results = new Map<string, string>();
    const provided = new Map<string, string>();

    setEditResults(
      [task("c1", "a.scss"), task("c2", "b.html")],
      candidate,
      results,
      provided,
    );

    expect(results.get("c1")).toContain("AAA");
    expect(results.get("c2")).toContain("BBB");
    expect(provided.get("a.scss")).toBe("AAA");
    expect(provided.get("b.html")).toBe("BBB");
  });
});
