import { describe, it, expect } from "vitest";
// Importing the wizard is safe: it only auto-runs when executed directly (guard at the bottom).
// @ts-expect-error — plain JS script shipped standalone to ~/.rei/scripts, no .d.ts by design.
import { validateProviderKeys, suggestProvider } from "../../scripts/launch-rei.js";

/**
 * A single typo in the user's own `launch-rei.config.js` cost a debugging session. The key was
 * `llmstudio` (three l's) instead of `lmstudio`, and the wizard built its provider menu from
 * `Object.keys(PROVIDER_MODELS)` without checking the names against anything.
 *
 * What the user saw: `llmstudio` offered in the menu, chosen, and then no endpoint prompt, no API-key
 * prompt and an empty model list — because `LOCAL_PROVIDERS` does not contain that spelling, so
 * `prepareProvider()` never probed the server and returned `{ models: [] }`. The curated fallback for
 * local providers is deliberately empty, so "I found no models" and "I have no idea what this
 * provider is" rendered identically: nothing.
 */
describe("suggestProvider", () => {
  it("catches the typo that caused this", () => {
    expect(suggestProvider("llmstudio")).toBe("lmstudio");
  });

  it("catches other near misses, in either direction", () => {
    expect(suggestProvider("lmstudo")).toBe("lmstudio");
    expect(suggestProvider("olama")).toBe("ollama");
    expect(suggestProvider("openrouterr")).toBe("openrouter");
    expect(suggestProvider("gemeni")).toBe("gemini");
  });

  it("offers nothing for a name that is not a typo of anything", () => {
    // Better silent than confidently wrong: "did you mean X?" for something unrelated sends the
    // reader down the wrong path.
    expect(suggestProvider("vllm")).toBeUndefined();
    expect(suggestProvider("my-own-backend")).toBeUndefined();
  });
});

describe("validateProviderKeys", () => {
  it("accepts every provider REI actually supports", () => {
    const known = {
      ollama: [], lmstudio: [], mtplx: [], omlx: [], "openai-compat": [],
      openrouter: [], gemini: [], groq: [], huggingface: [], mock: [],
    };
    const r = validateProviderKeys(known);
    expect(r.unknown).toEqual([]);
    expect(Object.keys(r.valid).sort()).toEqual(Object.keys(known).sort());
  });

  it("reports the unknown key WITH its suggestion, and drops it from the menu", () => {
    const r = validateProviderKeys({ ollama: [], llmstudio: ["a"] });
    expect(r.unknown).toEqual([{ key: "llmstudio", suggestion: "lmstudio" }]);
    // Dropped, so no phantom option is offered that cannot possibly work.
    expect(Object.keys(r.valid)).toEqual(["ollama"]);
  });

  it("reports an unknown key with no suggestion rather than guessing", () => {
    const r = validateProviderKeys({ "some-gateway": [] });
    expect(r.unknown).toEqual([{ key: "some-gateway", suggestion: undefined }]);
  });

  it("survives a missing or malformed config", () => {
    expect(validateProviderKeys(undefined).unknown).toEqual([]);
    expect(validateProviderKeys({}).valid).toEqual({});
  });
});
