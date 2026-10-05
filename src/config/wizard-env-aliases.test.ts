import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * `LMSTUDIO_` is the documented prefix (.env.example) and the runtime aliases it to `LLM_STUDIO_`
 * in src/load-env.ts. The launcher never imports that module, so its preflight read only the legacy
 * spelling: a project configured with LMSTUDIO_MODEL failed with "no LLM_STUDIO_MODEL set", and a
 * LMSTUDIO_BASE_URL pointing at another machine was ignored in favour of localhost.
 */
const SCRIPT = fileURLToPath(new URL("../../scripts/launch-rei.js", import.meta.url));

// A high port nothing listens on (not 9: fetch refuses it outright as a "bad port"), so the probe
// fails fast and the reason names the URL the preflight actually used — what these tests assert.
function preflight(env: Record<string, string>): string {
  const home = mkdtempSync(join(tmpdir(), "rei-preflight-"));
  const r = spawnSync(process.execPath, [SCRIPT, "--preflight"], {
    env: { PATH: process.env.PATH ?? "", HOME: home, MODEL_PROVIDER: "lmstudio", ...env },
    encoding: "utf8",
    timeout: 15000,
  });
  return r.stderr;
}

describe("launcher preflight honours the LMSTUDIO_ prefix", () => {
  it("finds the model and the endpoint under LMSTUDIO_", () => {
    const err = preflight({
      LMSTUDIO_MODEL: "qwen3.8-27b",
      LMSTUDIO_BASE_URL: "http://127.0.0.1:65534/v1",
    });
    expect(err).not.toContain("no LLM_STUDIO_MODEL set");
    expect(err).toContain("cannot reach lmstudio server at http://127.0.0.1:65534/v1");
    // The probe says WHY, not just that it failed.
    expect(err).toContain("ECONNREFUSED");
  });

  it("lets the legacy spelling win when both are set, as the runtime does", () => {
    const err = preflight({
      LLM_STUDIO_MODEL: "qwen3.8-27b",
      LLM_STUDIO_BASE_URL: "http://127.0.0.1:65534/v1",
      LMSTUDIO_BASE_URL: "http://127.0.0.1:65533/v1",
    });
    expect(err).toContain("cannot reach lmstudio server at http://127.0.0.1:65534/v1");
  });
});
