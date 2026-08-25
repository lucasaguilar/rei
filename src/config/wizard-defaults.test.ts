import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";

/**
 * The tuning block the setup wizard writes into rei.config.json for a freshly selected local model.
 * These values are what a NEW user runs with, and a per-model value always beats REI's global env
 * default — so writing 0.0 penalties here silently disables the anti-loop protection that
 * resolveAgentSampling() provides. That is exactly how a calibrated setup regressed once.
 *
 * Loaded from the wizard's real source: it's plain JS that ships standalone to ~/.rei/scripts and
 * can't be imported, but it must not drift unnoticed.
 */
type Tuning = {
  id: string;
  contextWindow: number;
  maxTokens: number;
  temperature: number;
  topP: number;
  topK: number;
  presencePenalty: number;
  frequencyPenalty: number;
  minP: number;
  repetitionPenalty?: number;
};

function loadWizard(): { defaultTuning: (id: string) => Tuning; probed: Map<string, number> } {
  const src = readFileSync(
    fileURLToPath(new URL("../../scripts/launch-rei.js", import.meta.url)),
    "utf8",
  );
  const pieces = ["const PROBED_CONTEXT = new Map();", "const DEFAULT_LOCAL_CONTEXT = 65536;"];
  const fn = src.match(/function defaultTuning[\s\S]*?\n}/)?.[0];
  if (!fn) throw new Error("defaultTuning not found — did launch-rei.js get refactored?");
  for (const p of pieces) {
    if (!src.includes(p)) throw new Error(`wizard no longer declares: ${p}`);
  }
  const out = new Function(`${pieces.join("\n")}\n${fn}\nreturn { defaultTuning, probed: PROBED_CONTEXT };`)();
  return out as ReturnType<typeof loadWizard>;
}

describe("defaults del wizard", () => {
  const { defaultTuning, probed } = loadWizard();

  it("anti-loop encendido: ningún modelo sale con las penalties en cero", () => {
    for (const id of ["some-random-7b", "qwen3.8-27b", "deepseek-r1-14b", "gemma-4-31b"]) {
      const t = defaultTuning(id);
      expect(t.presencePenalty, id).toBeGreaterThan(0);
      expect(t.frequencyPenalty, id).toBeGreaterThan(0);
    }
  });

  it("no apila repetition_penalty sobre presence/frequency", () => {
    expect(defaultTuning("some-random-7b").repetitionPenalty).toBeUndefined();
  });

  it("qwen sale con su receta oficial y presence alto", () => {
    const t = defaultTuning("orcarouter/qwen3.8-27b-mlx@4bit");
    expect(t).toMatchObject({ temperature: 0.6, topP: 0.95, topK: 20, presencePenalty: 1.0 });
  });

  it("el contexto por defecto ya no es 32768", () => {
    expect(defaultTuning("some-random-7b").contextWindow).toBe(65536);
  });

  it("si el server publicó su contexto, ese gana", () => {
    probed.set("mtplx-qwen38-27b-optimized-speed", 65536);
    probed.set("tiny-model-2b", 8192);
    expect(defaultTuning("tiny-model-2b").contextWindow).toBe(8192);
    expect(defaultTuning("mtplx-qwen38-27b-optimized-speed").contextWindow).toBe(65536);
    probed.clear();
  });

  it("el id se preserva tal cual lo reporta el server", () => {
    expect(defaultTuning("orcarouter/Qwen3.8-27B-MLX@4bit").id).toBe("orcarouter/Qwen3.8-27B-MLX@4bit");
  });
});
