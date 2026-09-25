import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, chmodSync, existsSync } from "fs";
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

// The wizard writes to the canonical <ws>/.rei/.env.
const envPath = () => join(ws, ".rei", ".env");
const readEnv = () => readFileSync(envPath(), "utf8");

describe("writeProjectEnv", () => {
  it("creates .env inside the workspace's .rei/ and returns its path", () => {
    const out = writeProjectEnv(ws, { MODEL_PROVIDER: "lmstudio" });
    expect(out).toBe(envPath());
    expect(readEnv()).toMatch(/^MODEL_PROVIDER=lmstudio$/m);
  });

  it("updates an existing key in place instead of appending a duplicate", () => {
    mkdirSync(join(ws, ".rei"), { recursive: true });
    writeFileSync(envPath(), "MODEL_PROVIDER=ollama\nMY_OWN_VAR=keepme\n");
    writeProjectEnv(ws, { MODEL_PROVIDER: "mtplx" });
    const env = readEnv();
    expect(env).toMatch(/^MODEL_PROVIDER=mtplx$/m);
    expect(env.match(/^MODEL_PROVIDER=/gm)).toHaveLength(1);
  });

  it("preserves variables the user added by hand", () => {
    mkdirSync(join(ws, ".rei"), { recursive: true });
    writeFileSync(envPath(), "MY_SECRET=abc123\nGITHUB_TOKEN=ghp_xyz\n");
    writeProjectEnv(ws, { MODEL_PROVIDER: "lmstudio" });
    const env = readEnv();
    expect(env).toMatch(/^MY_SECRET=abc123$/m);
    expect(env).toMatch(/^GITHUB_TOKEN=ghp_xyz$/m);
  });

  it("writes several keys in one call", () => {
    writeProjectEnv(ws, {
      MODEL_PROVIDER: "lmstudio",
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
    expect(() => { out = writeProjectEnv(ws, { MODEL_PROVIDER: "lmstudio" }); }).not.toThrow();
    expect(out).toBeNull();
    expect(console.error).toHaveBeenCalled();
    expect(existsSync(envPath())).toBe(false);
  });
});

/**
 * The file the wizard writes holds API keys, and it lands inside the user's repository. The code
 * used to assume `.rei/` was already gitignored — true in REI's own repo, false in the project a
 * new user runs `rei` in for the first time. One `git add -A` later, the key is in a commit.
 *
 * So the directory ignores itself: a nested `.gitignore` containing `*` needs no cooperation from
 * the user's own ignore file, and git honours it wherever the project sits.
 */
describe("the .rei directory ignores itself", () => {
  const ignorePath = () => join(ws, ".rei", ".gitignore");

  it("writes a .gitignore next to the .env it just created", () => {
    writeProjectEnv(ws, { OPENROUTER_API_KEY: "sk-or-v1-secret" });
    expect(existsSync(ignorePath())).toBe(true);
    expect(readFileSync(ignorePath(), "utf8")).toMatch(/^\*$/m);
  });

  it("leaves an existing .gitignore alone — the user may have narrowed it deliberately", () => {
    mkdirSync(join(ws, ".rei"), { recursive: true });
    writeFileSync(ignorePath(), "# mine\n.env\n");
    writeProjectEnv(ws, { MODEL_PROVIDER: "lmstudio" });
    expect(readFileSync(ignorePath(), "utf8")).toBe("# mine\n.env\n");
  });

  it("still writes the .env when the .gitignore cannot be written", () => {
    // Best-effort: a protected .rei/ must not cost the user their configuration.
    writeProjectEnv(ws, { MODEL_PROVIDER: "ollama" });
    expect(existsSync(envPath())).toBe(true);
  });
});
