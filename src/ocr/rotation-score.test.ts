import { describe, it, expect } from "vitest";
import { scoreOcrText } from "./rotation-score.js";

// Real upright transcription (excerpt of the D&D guide that triggered this feature).
const COHERENT =
  "Los ataques cuerpo a cuerpo te permiten atacar a un objetivo que esté a tu alcance. " +
  "Un ataque de este tipo suele emplear un arma de mano o bien hacerse sin armas. " +
  "Muchos monstruos realizan ataques cuerpo a cuerpo con garras o colmillos.";

// What the model emitted for the SAME page rotated 90° — a hallucinated counting loop.
const COUNTING_LOOP =
  "PÁG. 18\nPÁG. 19\nPÁG. 20\nPÁG. 21\nPÁG. 22\nPÁG. 23\nPÁG. 24\nPÁG. 25\nPÁG. 26\nPÁG. 27";

describe("scoreOcrText", () => {
  it("scores coherent prose well above a counting loop", () => {
    expect(scoreOcrText(COHERENT)).toBeGreaterThan(scoreOcrText(COUNTING_LOOP));
  });

  it("gives the counting loop a low (near-zero-or-negative) score", () => {
    expect(scoreOcrText(COUNTING_LOOP)).toBeLessThan(0.05);
  });

  it("rewards function-word density in real prose", () => {
    expect(scoreOcrText(COHERENT)).toBeGreaterThan(0.1);
  });

  it("returns 0 for text too short to judge", () => {
    expect(scoreOcrText("hola")).toBe(0);
    expect(scoreOcrText("")).toBe(0);
  });

  it("penalizes a single repeated token (degenerate loop)", () => {
    const repeated = "casa ".repeat(30);
    expect(scoreOcrText(repeated)).toBeLessThan(scoreOcrText(COHERENT));
  });
});
