import { describe, it, expect } from "vitest";
import { parseGroundedResponse } from "./prompt.js";

describe("parseGroundedResponse", () => {
  it("parses fenced JSON with claims", () => {
    const r =
      '```json\n{"answer":"X","claims":[{"text":"a","page":3,"quote":"q"}],"notFound":false}\n```';
    const p = parseGroundedResponse(r);
    expect(p.answer).toBe("X");
    expect(p.claims[0]).toEqual({ text: "a", page: 3, quote: "q" });
    expect(p.notFound).toBe(false);
  });

  it("parses JSON surrounded by stray prose", () => {
    const r = 'Here is the answer:\n{"answer":"Y","claims":[],"notFound":true} hope it helps';
    const p = parseGroundedResponse(r);
    expect(p.answer).toBe("Y");
    expect(p.notFound).toBe(true);
  });

  it("falls back to raw text when the response isn't JSON", () => {
    const p = parseGroundedResponse("no json here");
    expect(p.answer).toBe("no json here");
    expect(p.claims).toEqual([]);
  });

  it("ignores DRAFT JSON inside a <think> block and parses the final JSON", () => {
    const r =
      "<think>Let me draft: {\"answer\":\"WRONG\",\"claims\":[],\"notFound\":false} hmm</think>\n" +
      '```json\n{"answer":"RIGHT","claims":[{"text":"t","page":82,"quote":"q"}],"notFound":false}\n```';
    const p = parseGroundedResponse(r);
    expect(p.answer).toBe("RIGHT");
    expect(p.claims[0].page).toBe(82);
  });

  it("handles an unclosed <think> (thinking cut off) by stripping to end", () => {
    const r = '{"answer":"A","claims":[],"notFound":false}\n<think>still thinking…';
    const p = parseGroundedResponse(r);
    expect(p.answer).toBe("A");
  });
});
