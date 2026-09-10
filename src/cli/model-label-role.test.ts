import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolveActiveModelLabel } from "./helpers/input-turn.helpers.js";

const saved = { ...process.env };
beforeEach(() => {
  process.env.MODEL_PROVIDER = "llmstudio";
  process.env.LLM_STUDIO_MODEL = "qwen/qwen3.8-27b";
  process.env.LLM_STUDIO_MODEL_AGENT = "qwen/qwen3.8-27b";
});
afterEach(() => {
  process.env = { ...saved };
});

/**
 * The status bar must name the model the turn ACTUALLY ran on.
 *
 * It used to re-derive it from the session mode, which held until a role could change the model
 * without changing the mode. Activating one then printed "Runs on gemma-4-26b" while the bar kept
 * saying qwen3.8-27b for the rest of the session — and the bar is what you check when a reply is
 * slow or a window looks wrong, so it was wrong exactly when consulted.
 */
describe("the status bar names the model that ran", () => {
  it("reports the model the turn handed back, not the mode's", () => {
    expect(resolveActiveModelLabel("agent", "google/gemma-4-26b-a4b-qat")).toContain("gemma-4-26b");
  });

  it("does not name the session model when a role replaced it", () => {
    expect(resolveActiveModelLabel("agent", "google/gemma-4-26b-a4b-qat")).not.toContain("qwen");
  });

  it("falls back to the mode's model before any turn has run", () => {
    // The startup gauge draws before there is a reported model.
    expect(resolveActiveModelLabel("agent")).toContain("qwen/qwen3.8-27b");
  });

  it("treats an empty reported model as absent rather than printing nothing", () => {
    expect(resolveActiveModelLabel("agent", "")).toContain("qwen/qwen3.8-27b");
  });

  it("keeps the provider and its icon", () => {
    const label = resolveActiveModelLabel("agent", "google/gemma-4-26b-a4b-qat");
    expect(label).toContain("llmstudio");
    expect(label).toContain("💻");
  });
});
