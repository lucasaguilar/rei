import { describe, expect, it, afterEach, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { normalizeProviderName, normalizeProviderKeys } from "./provider-names.js";
import { createModelProvider, resolveModelForMode } from "./provider-factory.js";
import { resolveModelTuning } from "../config/model-tuning.js";

/**
 * LM Studio's provider key was `llmstudio` until the rename. Every install written before it — the
 * `.env`, the `rei.config.json`, a typed `/provider` — must keep working, because the two failures
 * are ugly in opposite ways: the env one throws "Unknown MODEL_PROVIDER", and the config one fails
 * SILENTLY, dropping the model's tuning back to global defaults with nothing on screen.
 */
describe("the llmstudio → lmstudio alias", () => {
  const saved = { ...process.env };

  beforeEach(() => {
    // A dev shell may carry real per-mode overrides (LLM_STUDIO_MODEL_ASK, …) that would shadow
    // the single <PREFIX>_MODEL this suite asserts on; clear them so resolution is deterministic.
    // afterEach restores the captured env, so the real values come back after each test.
    for (const key of Object.keys(process.env)) {
      if (/_MODEL_(ASK|PLANNING|AGENT)$/.test(key)) delete process.env[key];
    }
  });

  afterEach(() => {
    process.env = { ...saved };
  });

  it("normalises the old spellings and leaves unknown names alone", () => {
    expect(normalizeProviderName("llmstudio")).toBe("lmstudio");
    expect(normalizeProviderName("LLMStudio")).toBe("lmstudio");
    expect(normalizeProviderName(" lm-studio ")).toBe("lmstudio");
    expect(normalizeProviderName("ollama")).toBe("ollama");
    expect(normalizeProviderName("nonsense")).toBe("nonsense");
  });

  it("starts the provider from an old MODEL_PROVIDER without throwing", () => {
    process.env.MODEL_PROVIDER = "llmstudio";
    expect(() => createModelProvider()).not.toThrow();
  });

  it("still finds the env prefix, so the model resolves", () => {
    process.env.MODEL_PROVIDER = "llmstudio";
    process.env.LLM_STUDIO_MODEL = "qwen/qwen3.6-35b-a3b";
    expect(resolveModelForMode("ask")).toBe("qwen/qwen3.6-35b-a3b");
  });

  it("keeps the canonical entry when a config carries both spellings", () => {
    const merged = normalizeProviderKeys({ lmstudio: "new", llmstudio: "old" });
    expect(merged).toEqual({ lmstudio: "new" });
  });

  it("reads per-model tuning from a rei.config.json written as 'llmstudio'", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rei-alias-"));
    try {
      fs.writeFileSync(
        path.join(dir, "rei.config.json"),
        JSON.stringify({
          providers: { llmstudio: { models: [{ id: "qwen3.8-27b", contextWindow: 61440 }] } },
        }),
      );
      expect(resolveModelTuning("qwen3.8-27b", dir, "lmstudio")?.contextWindow).toBe(61440);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
