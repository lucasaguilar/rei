import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { matchModel, type ModelTuning } from "./model-tuning.js";

/**
 * The setup wizard (`scripts/launch-rei.js`) decides whether a selected model is ALREADY tuned in
 * rei.config.json; `matchModel()` decides which tuning a model gets at RUNTIME. Both answer the same
 * question, in different languages — the wizard is plain JS that ships standalone to ~/.rei/scripts
 * and cannot import this module.
 *
 * When the two disagreed, `rei --config` appended a duplicate entry with DEFAULT sampling for a model
 * the user had already hand-tuned (the server reports "orcarouter/qwen3.8-27b-mlx@4bit"; the config
 * stored "qwen3.8-27b-mlx@4bit"). matchModel prefers the exact id, so the duplicate won and the
 * tuning was silently reverted — anti-loop penalties back to 0, context 262144 → 32768.
 *
 * This test loads the wizard's real source and pins the two implementations together.
 */
function loadWizardPredicate(): (models: ModelTuning[], model: string) => boolean {
  const src = readFileSync(
    fileURLToPath(new URL("../../scripts/launch-rei.js", import.meta.url)),
    "utf8",
  );
  const normalize = src.match(/function normalizeModelId[\s\S]*?\n}/)?.[0];
  const isTuned = src.match(/function isModelTuned[\s\S]*?\n}/)?.[0];
  if (!normalize || !isTuned) {
    throw new Error("wizard helpers not found — did launch-rei.js get renamed/refactored?");
  }
  return new Function(`${normalize}\n${isTuned}\nreturn isModelTuned;`)() as ReturnType<
    typeof loadWizardPredicate
  >;
}

const entries = (...ids: string[]): ModelTuning[] => ids.map((id) => ({ id }));

const CASES: [string, ModelTuning[], string][] = [
  ["exact id", entries("qwen3.8-27b-mlx@4bit"), "qwen3.8-27b-mlx@4bit"],
  ["org-prefixed model vs short entry", entries("qwen3.8-27b-mlx@4bit"), "orcarouter/qwen3.8-27b-mlx@4bit"],
  ["short model vs org-prefixed entry", entries("orcarouter/qwen3.8-27b-mlx@4bit"), "qwen3.8-27b-mlx@4bit"],
  ["-thinking variant", entries("ornith-1.5-35b"), "ornith-1.5-35b-thinking"],
  ["different quantization must NOT match", entries("qwen3.8-27b-mlx@5bit"), "qwen3.8-27b-mlx@4bit"],
  ["unrelated model", entries("gemma-4-31b"), "qwen3.8-27b-mlx@4bit"],
  ["empty entry id is ignored", entries(""), "qwen3.8-27b-mlx@4bit"],
  ["case and whitespace", entries("  QWEN3.8-27B-MLX@4BIT "), "qwen3.8-27b-mlx@4bit"],
  ["no entries at all", [], "anything"],
  ["two orgs, same model", entries("lmstudio-community/qwen3.8-27b-mlx"), "orcarouter/qwen3.8-27b-mlx"],
];

describe("wizard vs matchModel: same answer, always", () => {
  const wizardSaysTuned = loadWizardPredicate();
  for (const [name, models, model] of CASES) {
    it(name, () => {
      expect(wizardSaysTuned(models, model)).toBe(matchModel(model, models) !== undefined);
    });
  }

  it("the real regression: no duplicate is appended for an already-tuned model", () => {
    const tuned: ModelTuning[] = [
      { id: "qwen3.8-27b-mlx@4bit", presencePenalty: 1.0, contextWindow: 262144 },
    ];
    expect(wizardSaysTuned(tuned, "orcarouter/qwen3.8-27b-mlx@4bit")).toBe(true);
  });
});
