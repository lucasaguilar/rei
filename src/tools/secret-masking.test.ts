import { describe, it, expect, afterEach } from "vitest";
import { maskSecrets, SECRET_MASK } from "./secret-masking.js";
import { executeCommand } from "./command-executor.js";
import { STATIC_ALLOWED_COMMANDS } from "./sandbox-config.js";
import { tmpdir } from "node:os";

/**
 * `read_files` refuses to serve `.env` unless REI_ALLOW_SENSITIVE_READS=true — and then
 * `run_command` handed the same secrets over without a word: `env` printed every variable in the
 * process, `cat .env` printed the file. Measured with a canary: the key came back in full.
 *
 * It matters most in the setup the README recommends: with agent mode on a cloud provider, whatever
 * a command prints is sent to a third party, and it is also written to `.rei/logs/agent-flow.jsonl`.
 */
afterEach(() => {
  delete process.env.REI_ALLOW_SENSITIVE_READS;
});

describe("maskSecrets", () => {
  it("masks the value of an assignment whose name ends in a secret word", () => {
    expect(maskSecrets("OPENROUTER_API_KEY=sk-or-v1-abc123")).toBe(`OPENROUTER_API_KEY=${SECRET_MASK}`);
    expect(maskSecrets("HF_TOKEN=hf_aaaaaaaaaaaaaaaaaaaa")).toBe(`HF_TOKEN=${SECRET_MASK}`);
    expect(maskSecrets('  "api_key": "sk-abc12345"')).toContain(SECRET_MASK);
    expect(maskSecrets("password: hunter2")).toBe(`password: ${SECRET_MASK}`);
  });

  it("keeps the NAME visible — the model needs to know the variable is set", () => {
    expect(maskSecrets("GROQ_API_KEY=gsk_zzzzzzzz")).toContain("GROQ_API_KEY");
  });

  it("masks well-known token shapes even with no name attached", () => {
    expect(maskSecrets("curl failed for sk-or-v1-9f8e7d6c5b4a3210")).not.toContain("9f8e7d6c");
    expect(maskSecrets("remote: ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")).toContain(SECRET_MASK);
  });

  it("leaves ordinary output alone", () => {
    for (const line of [
      "PWD=/Users/someone/www/repo",
      "KEYWORD=search",     // ends in WORD — the rule is "ends in a secret word", not "contains"
      "TOKENIZER=bpe",
      "src/keychain.ts:12: error TS2304: Cannot find name 'foo'",
      "npm WARN deprecated core-js@2.6.12",
    ]) {
      expect(maskSecrets(line), line).toBe(line);
    }
  });

  it("over-masks a name that merely ends in a secret word, and that is the accepted trade", () => {
    // MONKEY ends in KEY. Masking it costs a readable line; the alternative — a curated list of
    // real variable names — silently misses the next provider's.
    expect(maskSecrets("MONKEY=banana")).toContain(SECRET_MASK);
  });

  it("is a no-op when the user asked for sensitive material on purpose", () => {
    process.env.REI_ALLOW_SENSITIVE_READS = "true";
    expect(maskSecrets("OPENROUTER_API_KEY=sk-or-v1-abc123")).toBe("OPENROUTER_API_KEY=sk-or-v1-abc123");
  });
});

describe("run_command output", () => {
  it("comes back masked, end to end", async () => {
    const r = await executeCommand('echo "OPENROUTER_API_KEY=sk-or-v1-CANARY-123"', tmpdir());
    expect(r.stdout).not.toContain("CANARY");
    expect(r.stdout).toContain(SECRET_MASK);
  });
});

describe("the allow-list", () => {
  it("no longer offers `env`, whose entire output is the process environment", () => {
    // Masking covers the values; not offering the command at all also keeps the variable NAMES —
    // which spell out the machine's whole configuration — out of a third party's logs.
    expect(STATIC_ALLOWED_COMMANDS.has("env")).toBe(false);
  });
});
