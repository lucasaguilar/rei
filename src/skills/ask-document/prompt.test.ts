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

  it("rescues the answer from TRUNCATED JSON (cut mid-object) instead of dumping raw JSON", () => {
    // The model hit the output cap mid-claims → no closing brace → JSON.parse fails.
    const r = '{"answer":"La IA es un agente autónomo.","claims":[{"text":"x","page":12,"quo';
    const p = parseGroundedResponse(r);
    expect(p.answer).toBe("La IA es un agente autónomo.");
    expect(p.answer).not.toContain('"answer"');
  });

  it("does NOT leak a pure-<think> response (all budget spent reasoning, no answer)", () => {
    const r = "<think>" + "El usuario quiere sumar. ".repeat(50) + "</think>";
    const p = parseGroundedResponse(r);
    expect(p.answer).not.toContain("<think>");
    expect(p.answer).not.toContain("El usuario quiere sumar");
    expect(p.notFound).toBe(true);
  });

  it("repairs trailing commas in claims array", () => {
    const r = '{"answer":"OK","claims":[{"text":"afirmacion","page":5,"quote":"cita"},],"notFound":false}';
    const p = parseGroundedResponse(r);
    expect(p.answer).toBe("OK");
    expect(p.claims).toHaveLength(1);
    expect(p.claims[0]).toEqual({ text: "afirmacion", page: 5, quote: "cita" });
  });

  it("deduplicates identical claims (same page and quote)", () => {
    const r = JSON.stringify({
      answer: "OK",
      claims: [
        { text: "a", page: 17, quote: "Numerosas empresas..." },
        { text: "b", page: 13, quote: "A menudo..." },
        { text: "a", page: 17, quote: "Numerosas empresas..." },
        { text: "b", page: 13, quote: "A menudo..." },
      ],
      notFound: false,
    });
    const p = parseGroundedResponse(r);
    expect(p.claims).toHaveLength(2);
    expect(p.claims[0].quote).toBe("Numerosas empresas...");
    expect(p.claims[1].quote).toBe("A menudo...");
  });
});


