import { describe, it, expect } from "vitest";
import { splitCutToolCalls, cutToolCallNotice } from "./cut-tool-calls.js";
import type { ToolCall } from "../../providers/model-provider.js";

const call = (name: string, args: string): ToolCall => ({
  id: `c_${name}`,
  type: "function",
  function: { name, arguments: args },
});

describe("splitCutToolCalls", () => {
  const whole = call("read_files", '{"paths":["a.ts"]}');
  const cut = call("rewrite_file", '{"path":"doc.md","content":"half');

  it("on a length finish, separates the half-written call from the complete ones", () => {
    expect(splitCutToolCalls("length", [whole, cut])).toEqual({ complete: [whole], cut: [cut] });
  });

  it("leaves every call alone when the model stopped on its own", () => {
    // A malformed call without a length finish is not a truncation — the dispatcher reports it.
    expect(splitCutToolCalls("tool_calls", [whole, cut])).toEqual({ complete: [whole, cut], cut: [] });
  });
});

describe("cutToolCallNotice", () => {
  it("names the cut tool once and says it did not run", () => {
    const notice = cutToolCallNotice([call("rewrite_file", "{"), call("rewrite_file", '{"a"')]);
    expect(notice).toMatch(/^Your rewrite_file call/);
    expect(notice).toContain("NOT executed");
  });
});
