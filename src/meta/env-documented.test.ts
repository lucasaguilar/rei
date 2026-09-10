import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Every environment variable REI reads must appear in `docs/config-reference.md`.
 *
 * Undocumented configuration is the mirror of configuration that is parsed and never enforced: the
 * behaviour exists, and no one outside this repository can find it. The launch audit found eleven,
 * and one of them mattered — the reference states the convention `<PREFIX>_API_KEY`, but the
 * Hugging Face provider only reads `HF_TOKEN`. Someone following the documented convention sets
 * `HF_API_KEY`, and authenticates nothing.
 *
 * The reference uses shorthand for families (`REI_VISION_MODEL/_BASE_URL`, `LMNR_*`,
 * `A / _B / _C`), so a name counts as documented if it is written out, appears as a `_SUFFIX`
 * continuation, or belongs to a family listed in WILDCARD_FAMILIES.
 *
 * That last list is explicit rather than "any `PREFIX_*` found in the doc", and the difference is
 * the whole test. The reference opens by naming its categories — "Agnostic (`REI_*`)" — so a
 * pattern rule read that as documenting every REI_ variable there will ever be, and the guardrail
 * passed on a freshly invented flag. A category is not an entry.
 */

const SRC = path.resolve(__dirname, "..");
const DOC = path.resolve(__dirname, "../../docs/config-reference.md");

/**
 * Families the reference genuinely documents as a group, each with the section that does it.
 * Adding to this list exempts every variable under the prefix — so it takes a real group entry,
 * not a passing mention of the prefix.
 */
const WILDCARD_FAMILIES: Record<string, string> = {
  LMNR: "Laminar telemetry — an upstream SDK's own variables, listed as `LMNR_*`",
};

/** Variables owned by the shell or the OS — REI reads them, it does not define them. */
const NOT_REI_CONFIG = new Set([
  "HOME", "PATH", "PWD", "USER", "SHELL", "LANG", "NODE_ENV", "CI",
  "TERM", "TERM_PROGRAM", "COLORTERM", "NO_COLOR", "FORCE_COLOR", "XDG_CONFIG_HOME",
  "KITTY_WINDOW_ID", "WT_SESSION", "VTE_VERSION", "WAYLAND_DISPLAY", "DISPLAY",
]);

const walk = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : p.endsWith(".ts") && !p.endsWith(".test.ts") ? [p] : [];
  });

const doc = fs.readFileSync(DOC, "utf-8");

export function isDocumented(name: string, reference = doc): boolean {
  if (reference.includes(name)) return true;
  const parts = name.split("_");
  if (parts[0] in WILDCARD_FAMILIES && new RegExp(`\\b${parts[0]}_\\*`).test(reference)) return true;
  for (let i = 1; i < parts.length; i++) {
    const suffix = `_${parts.slice(i).join("_")}`; // `A_B / _C_D` shorthand
    if (new RegExp(`[/·\\s]${suffix}\\b`).test(reference)) return true;
  }
  return false;
}

const readVars = new Set<string>();
for (const file of walk(SRC)) {
  for (const m of fs.readFileSync(file, "utf-8").matchAll(/process\.env\.([A-Z][A-Z0-9_]{2,})/g)) {
    if (!NOT_REI_CONFIG.has(m[1])) readVars.add(m[1]);
  }
}

describe("every env var REI reads is documented", () => {
  it("finds no undocumented variable", () => {
    const missing = [...readVars].filter((v) => !isDocumented(v)).sort();
    expect(
      missing,
      "Env vars read by the code but absent from docs/config-reference.md. Document them with " +
        "their default, or add them to NOT_REI_CONFIG if the shell owns them.",
    ).toEqual([]);
  });

  it("actually reads a meaningful number of variables, so the net is not empty", () => {
    // A refactor that changed how env is read would otherwise turn this file into a no-op that
    // keeps passing.
    expect(readVars.size).toBeGreaterThan(80);
  });

  it("resolves the reference's shorthand, and does not match on a coincidence", () => {
    expect(isDocumented("LMNR_HTTP_PORT", "telemetry `LMNR_*`.")).toBe(true);
    expect(isDocumented("REI_VISION_BASE_URL", "`REI_VISION_MODEL` · `REI_VISION_BASE_URL`")).toBe(true);
    expect(isDocumented("OLLAMA_REPEAT_PENALTY", "`OLLAMA_TEMPERATURE / _REPEAT_PENALTY`")).toBe(true);
    expect(isDocumented("HF_TOKEN", "`<PREFIX>_API_KEY` covers every provider")).toBe(false);
    // The bug this test file shipped with: the reference's own category label read as coverage.
    expect(isDocumented("REI_INVENTED_FLAG", "**Agnostic (`REI_*`)** — apply to any provider.")).toBe(false);
  });
});
