import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolveModelForRole } from "./provider-factory.js";
import { compactorModelFor } from "../chat/compactor.js";

/**
 * The compactor and the vision model used to be single globals, while every conversation model was
 * already per-provider. Switching `MODEL_PROVIDER` — the one knob meant to switch everything —
 * therefore left them naming a model from the previous backend.
 *
 * The failure that follows is quiet, which is why it is worth pinning: `COMPACTOR_MODEL` holding
 * an LM Studio id, run against oMLX, 404s; compaction is skipped; and the session sails past its
 * context window instead of being summarised.
 */
const VARS = [
  "MODEL_PROVIDER",
  "AGENT_MODEL_PROVIDER",
  "COMPACTOR_MODEL",
  "OMLX_MODEL_COMPACTOR",
  "OMLX_MODEL_VISION",
  "LLM_STUDIO_MODEL_COMPACTOR",
  "LLM_STUDIO_MODEL_VISION",
];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const v of VARS) {
    saved[v] = process.env[v];
    delete process.env[v];
  }
});
afterEach(() => {
  for (const v of VARS) {
    if (saved[v] === undefined) delete process.env[v];
    else process.env[v] = saved[v]!;
  }
});

describe("resolveModelForRole", () => {
  it("reads the ACTIVE provider's variable", () => {
    process.env.MODEL_PROVIDER = "omlx";
    process.env.OMLX_MODEL_VISION = "Qwen3-VL-8B-MLX";
    expect(resolveModelForRole("vision")).toBe("Qwen3-VL-8B-MLX");
  });

  it("ignores another provider's variable, which is the whole point", () => {
    // Both declared, oMLX active: the LM Studio one must not leak in.
    process.env.MODEL_PROVIDER = "omlx";
    process.env.LLM_STUDIO_MODEL_VISION = "qwen2-vl-7b";
    expect(resolveModelForRole("vision")).toBeUndefined();
  });

  it("follows MODEL_PROVIDER, not AGENT_MODEL_PROVIDER", () => {
    // Summarising a session is not the agent's work; inheriting its dedicated backend would be
    // surprising in exactly the setup that flag exists for.
    process.env.MODEL_PROVIDER = "lmstudio";
    process.env.AGENT_MODEL_PROVIDER = "omlx";
    process.env.LLM_STUDIO_MODEL_COMPACTOR = "qwen3-4b";
    process.env.OMLX_MODEL_COMPACTOR = "no-deberia-salir";
    expect(resolveModelForRole("compactor")).toBe("qwen3-4b");
  });

  it("treats an empty value as unset, so it falls through instead of sending ''", () => {
    process.env.MODEL_PROVIDER = "omlx";
    process.env.OMLX_MODEL_VISION = "   ";
    expect(resolveModelForRole("vision")).toBeUndefined();
  });

  it("returns undefined for a provider it does not know", () => {
    process.env.MODEL_PROVIDER = "un-backend-inventado";
    expect(resolveModelForRole("compactor")).toBeUndefined();
  });
});

describe("compactorModelFor — precedence", () => {
  it("prefers the provider's own over the global", () => {
    process.env.MODEL_PROVIDER = "omlx";
    process.env.OMLX_MODEL_COMPACTOR = "el-del-provider";
    process.env.COMPACTOR_MODEL = "el-global";
    expect(compactorModelFor("el-de-la-sesion")).toBe("el-del-provider");
  });

  it("falls back to the global when this provider declares none", () => {
    process.env.MODEL_PROVIDER = "omlx";
    process.env.COMPACTOR_MODEL = "el-global";
    expect(compactorModelFor("el-de-la-sesion")).toBe("el-global");
  });

  it("ends at the session's own model, which is still the best default", () => {
    // No second model to load, no swap, and the cached prefix stays warm.
    process.env.MODEL_PROVIDER = "omlx";
    expect(compactorModelFor("el-de-la-sesion")).toBe("el-de-la-sesion");
  });

  it("returns undefined when there is nothing at all", () => {
    process.env.MODEL_PROVIDER = "omlx";
    expect(compactorModelFor(undefined)).toBeUndefined();
  });
});
