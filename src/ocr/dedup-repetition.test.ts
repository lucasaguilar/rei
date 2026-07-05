import { describe, it, expect } from "vitest";
import { collapseRepetition, repetitionRemoved } from "./dedup-repetition.js";

describe("collapseRepetition", () => {
  it("collapses the reported comma-separated clause loop to one instance", () => {
    const looped =
      "si tienes vulnerabilidad, sufras el daño de fuego, sufras el daño de fuego, " +
      "sufras el daño de fuego, sufras el daño de fuego, sufras el daño de fuego.";
    const out = collapseRepetition(looped);
    expect((out.match(/sufras el daño de fuego/g) ?? []).length).toBe(1);
    expect(out).toContain("si tienes vulnerabilidad");
  });

  it("collapses 3+ identical consecutive lines to one", () => {
    const looped = "Título\nlínea\nlínea\nlínea\nlínea\nFin";
    expect(collapseRepetition(looped)).toBe("Título\nlínea\nFin");
  });

  it("leaves a legit double repetition alone (needs 3+ in a row)", () => {
    expect(collapseRepetition("no, no, listo.")).toBe("no, no, listo.");
  });

  it("does not touch normal prose", () => {
    const prose =
      "El daño de fuego se reduce a la mitad si tienes resistencia, y se duplica con vulnerabilidad.";
    expect(collapseRepetition(prose)).toBe(prose);
  });

  it("is idempotent", () => {
    const looped = "a, foo bar, foo bar, foo bar, foo bar, b";
    const once = collapseRepetition(looped);
    expect(collapseRepetition(once)).toBe(once);
  });

  it("repetitionRemoved flags a big loop and ~ignores clean text", () => {
    const looped = "x, " + "foo bar baz, ".repeat(20) + "y";
    expect(repetitionRemoved(looped)).toBeGreaterThan(120);
    expect(repetitionRemoved("normal sentence, second clause.")).toBe(0);
  });
});
