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
  contextWindow?: number;
  maxTokens: number;
  temperature: number;
  topP: number;
  topK: number;
  presencePenalty: number;
  frequencyPenalty: number;
  minP: number;
  repetitionPenalty?: number;
  thinkingLevelMap?: Record<string, string | null>;
};

function loadWizard(): { defaultTuning: (id: string, chosenWindow?: string) => Tuning; probed: Map<string, number> } {
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

describe("wizard defaults", () => {
  const { defaultTuning, probed } = loadWizard();

  it("anti-loop on: no model is written with zeroed penalties", () => {
    for (const id of ["some-random-7b", "qwen3.8-27b", "deepseek-r1-14b", "gemma-4-31b"]) {
      const t = defaultTuning(id);
      expect(t.presencePenalty, id).toBeGreaterThan(0);
      expect(t.frequencyPenalty, id).toBeGreaterThan(0);
    }
  });

  it("does not stack repetition_penalty on top of presence/frequency", () => {
    expect(defaultTuning("some-random-7b").repetitionPenalty).toBeUndefined();
  });

  it("qwen keeps its official nucleus (topP/topK) at the coding temperature and presence penalty", () => {
    const t = defaultTuning("orcarouter/qwen3.8-27b-mlx@4bit");
    // presencePenalty 0.3, not Qwen's chat-recipe 1.0: code MUST repeat identifiers, and a high
    // presence penalty taxes every token already seen. frequencyPenalty is the anti-loop lever.
    expect(t).toMatchObject({ temperature: 0.35, topP: 0.95, topK: 20, presencePenalty: 0.3 });
  });

  it("qwen3.8 gets a thinkingLevelMap onto the only levels its template knows", () => {
    const map = defaultTuning("incoai/qwen3.8-27b-splash-reasoning").thinkingLevelMap;
    expect(map).toMatchObject({ minimal: "low", high: "xhigh" });
  });

  it("no thinkingLevelMap for other qwen generations (their range is not the same)", () => {
    expect(defaultTuning("mlx-community/qwen3.6-35b-a3b").thinkingLevelMap).toBeUndefined();
    expect(defaultTuning("qwen3-8b").thinkingLevelMap).toBeUndefined();
  });

  it("the window chosen in the wizard is the one written — a per-model value beats REI_CONTEXT_WINDOW", () => {
    expect(defaultTuning("some-random-7b", "98304").contextWindow).toBe(98304);
  });

  it("choosing 0 (no trimming) writes no contextWindow, so it cannot override that choice", () => {
    expect("contextWindow" in defaultTuning("some-random-7b", "0")).toBe(false);
  });

  it("a chosen window larger than what the server loaded is capped to the loaded one", () => {
    probed.set("tiny-model-2b", 8192);
    expect(defaultTuning("tiny-model-2b", "131072").contextWindow).toBe(8192);
    expect(defaultTuning("tiny-model-2b", "4096").contextWindow).toBe(4096);
    probed.clear();
  });

  it("the default context is no longer 32768", () => {
    expect(defaultTuning("some-random-7b").contextWindow).toBe(65536);
  });

  it("the server-reported context wins when it published one", () => {
    probed.set("mtplx-qwen38-27b-optimized-speed", 65536);
    probed.set("tiny-model-2b", 8192);
    expect(defaultTuning("tiny-model-2b").contextWindow).toBe(8192);
    expect(defaultTuning("mtplx-qwen38-27b-optimized-speed").contextWindow).toBe(65536);
    probed.clear();
  });

  it("the id is preserved exactly as the server reports it", () => {
    expect(defaultTuning("orcarouter/Qwen3.8-27B-MLX@4bit").id).toBe("orcarouter/Qwen3.8-27B-MLX@4bit");
  });
});
