import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
// Importing the wizard is safe: it only auto-runs when executed directly (guard at the bottom).
// @ts-expect-error — plain JS script shipped standalone to ~/.rei/scripts, no .d.ts by design.
import { suggestProvider, menuProviders } from "../../scripts/launch-rei.js";

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

/**
 * The provider menu used to be `Object.keys(PROVIDER_MODELS)` — the user's own curated model lists.
 * A file whose documented purpose is "your paths and models" was therefore deciding which providers
 * REI offers at all, with two consequences:
 *
 *  - a typo added a phantom provider (the bug above);
 *  - and, worse, a provider ABSENT from that file could not be chosen. With no config file at all the
 *    built-in fallback listed 7 of the 10 REI supports, so a new user with a Groq key could not pick
 *    Groq in the wizard.
 *
 * The taxonomy is now the source of the menu; the config only supplies model NAMES.
 */
describe("the provider menu comes from what REI supports", () => {
  it("offers every local and cloud provider, whatever the user's config says", () => {
    expect(menuProviders()).toEqual([
      // local first: this is a local-first tool, and the order is the recommendation
      "ollama", "lmstudio", "mtplx", "omlx", "openai-compat",
      "openrouter", "gemini", "groq", "huggingface",
    ]);
  });

  it("includes the two a fresh install used to hide", () => {
    expect(menuProviders()).toContain("groq");
    expect(menuProviders()).toContain("huggingface");
  });

  it("does not offer mock, which exists for tests rather than for users", () => {
    expect(menuProviders()).not.toContain("mock");
  });
});

/**
 * The wizard used to CREATE `scripts/launch-rei.config.js` on first run — copying the example, or
 * writing a stub when that was missing — and then read `PROJECTS` and `PROVIDER_MODELS` from it.
 * Nobody asked for the file, and it earned its keep twice over in bugs: a typo in a provider key
 * added a menu option that could not work, and a provider left out of it could not be chosen at all.
 *
 * Neither field was needed. The workspace list already includes the cwd, and the curated model names
 * are in KNOWN_MODELS, compiled in. So the file is gone rather than deprecated: a third config file
 * that does nothing is still a third config file to read and wonder about.
 */
describe("the launcher config file is gone", () => {
  const src = readFileSync(fileURLToPath(new URL("../../scripts/launch-rei.js", import.meta.url)), "utf8");

  it("is never imported", () => {
    expect(src).not.toMatch(/import\(['"]\.\/launch-rei\.config/);
  });

  it("is never written either — that is how everyone ended up with one", () => {
    expect(src).not.toMatch(/launch-rei\.config\.example/);
    expect(src).not.toMatch(/copyFileSync/);
  });

  it("still tells a user who has one that it is no longer read", () => {
    // Silently ignoring a file someone edited is the one outcome worse than reading it.
    expect(src).toMatch(/no longer read/i);
  });
});
