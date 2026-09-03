import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, chmodSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
// Importing the wizard is safe: it only auto-runs when executed directly (guard at the bottom).
// @ts-expect-error — plain JS script shipped standalone to ~/.rei/scripts, no .d.ts by design.
import { writeProjectEnv } from "../../scripts/launch-rei.js";

/**
 * The wizard's `.env` write is the payoff of the whole setup flow — and the step a user notices
 * when it doesn't happen. Two properties matter beyond "it writes a file":
 *   - an EXISTING .env is updated key-by-key, so variables the user added by hand survive;
 *   - a failure is reported and swallowed, never thrown, so it can't abort the run mid-way.
 */
let ws: string;

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), "rei-env-"));
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  try { chmodSync(ws, 0o755); } catch { /* already writable */ }
  rmSync(ws, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const readEnv = () => readFileSync(join(ws, ".env"), "utf8");

describe("writeProjectEnv", () => {
  it("creates .env in the selected workspace and returns its path", () => {
    const out = writeProjectEnv(ws, { MODEL_PROVIDER: "llmstudio" });
    expect(out).toBe(join(ws, ".env"));
    expect(readEnv()).toMatch(/^MODEL_PROVIDER=llmstudio$/m);
  });

  it("updates an existing key in place instead of appending a duplicate", () => {
    writeFileSync(join(ws, ".env"), "MODEL_PROVIDER=ollama\nMY_OWN_VAR=keepme\n");
    writeProjectEnv(ws, { MODEL_PROVIDER: "mtplx" });
    const env = readEnv();
    expect(env).toMatch(/^MODEL_PROVIDER=mtplx$/m);
    expect(env.match(/^MODEL_PROVIDER=/gm)).toHaveLength(1);
  });

  it("preserves variables the user added by hand", () => {
    writeFileSync(join(ws, ".env"), "MY_SECRET=abc123\nGITHUB_TOKEN=ghp_xyz\n");
    writeProjectEnv(ws, { MODEL_PROVIDER: "llmstudio" });
    const env = readEnv();
    expect(env).toMatch(/^MY_SECRET=abc123$/m);
    expect(env).toMatch(/^GITHUB_TOKEN=ghp_xyz$/m);
  });

  it("writes several keys in one call", () => {
    writeProjectEnv(ws, {
      MODEL_PROVIDER: "llmstudio",
      LLM_STUDIO_MODEL: "qwen3.8-27b-reasoning",
      REI_WORKSPACE_PATH: ws,
    });
    const env = readEnv();
    expect(env).toMatch(/^LLM_STUDIO_MODEL=qwen3\.8-27b-reasoning$/m);
    expect(env).toMatch(new RegExp(`^REI_WORKSPACE_PATH=${ws}$`, "m"));
  });

  it("reports and returns null when the directory is not writable — never throws", () => {
    chmodSync(ws, 0o555); // read-only
    let out: string | null = "not-set";
    expect(() => { out = writeProjectEnv(ws, { MODEL_PROVIDER: "llmstudio" }); }).not.toThrow();
    expect(out).toBeNull();
    expect(console.error).toHaveBeenCalled();
    expect(existsSync(join(ws, ".env"))).toBe(false);
  });
});
