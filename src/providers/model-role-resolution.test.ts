import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  resolveEndpointForActiveProvider,
  resolveModelForRole,
} from "./provider-factory.js";
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
  "OMLX_BASE_URL",
  "OMLX_API_KEY",
  "LLM_STUDIO_BASE_URL",
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

describe("resolveEndpointForActiveProvider", () => {
  it("returns the active provider's endpoint and key", () => {
    process.env.MODEL_PROVIDER = "omlx";
    process.env.OMLX_BASE_URL = "http://127.0.0.1:8000/v1";
    process.env.OMLX_API_KEY = "una-clave";
    expect(resolveEndpointForActiveProvider()).toEqual({
      baseUrl: "http://127.0.0.1:8000/v1",
      apiKey: "una-clave",
    });
  });

  it("does not hand over another provider's address", () => {
    // This is the mismatch it exists to prevent: a model resolved from OMLX_MODEL_VISION being
    // POSTed to LM Studio, which answers 404 for an id it has never heard of.
    process.env.MODEL_PROVIDER = "omlx";
    process.env.LLM_STUDIO_BASE_URL = "http://127.0.0.1:1234/v1";
    expect(resolveEndpointForActiveProvider().baseUrl).toBeUndefined();
  });

  it("returns nothing for an unknown provider, so the caller keeps its default", () => {
    process.env.MODEL_PROVIDER = "un-backend-inventado";
    expect(resolveEndpointForActiveProvider()).toEqual({});
  });
});
