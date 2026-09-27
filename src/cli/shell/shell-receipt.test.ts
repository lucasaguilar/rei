import { describe, it, expect, afterEach } from "vitest";
import { formatReceiptForModel, receiptLabel, type ShellReceipt } from "./shell-receipt.js";

const receipt = (over: Partial<ShellReceipt> = {}): ShellReceipt => ({
  command: "npm test",
  exitCode: 1,
  aborted: false,
  durationMs: 2300,
  output: "1 failing\n",
  attached: true,
  ...over,
});

describe("receiptLabel", () => {
  it("names the command, its exit code and the output size", () => {
    expect(receiptLabel(receipt({ output: "x".repeat(3100) }))).toBe("npm test (exit 1 · 3.1k)");
    expect(receiptLabel(receipt({ output: "ok\n", exitCode: 0 }))).toBe("npm test (exit 0 · 3 chars)");
    expect(receiptLabel(receipt({ aborted: true, exitCode: null }))).toMatch(/stopped/);
  });
});

describe("formatReceiptForModel", () => {
  const saved = process.env.REI_TOOL_OUTPUT_MAX_INLINE;
  afterEach(() => {
    if (saved === undefined) delete process.env.REI_TOOL_OUTPUT_MAX_INLINE;
    else process.env.REI_TOOL_OUTPUT_MAX_INLINE = saved;
  });

  it("presents it as verified evidence the model should not re-run", () => {
    const text = formatReceiptForModel(receipt());
    expect(text).toMatch(/^\[Verified/);
    expect(text).toMatch(/do not re-run/i);
    expect(text).toContain("$ npm test");
    expect(text).toContain("exit 1");
    expect(text).toContain("1 failing");
  });

  it("strips the colour codes that were only there for human eyes", () => {
    const text = formatReceiptForModel(receipt({ output: "\x1b[31mFAIL\x1b[0m src/a.test.ts\n" }));
    expect(text).toContain("FAIL src/a.test.ts");
    expect(text).not.toContain("\x1b[");
  });

  it("masks secrets — an attached `!env` must not ship API keys to the provider", () => {
    const text = formatReceiptForModel(
      receipt({ command: "env", output: "OPENROUTER_API_KEY=sk-or-v1-abcdef0123456789abcdef\n" }),
    );
    expect(text).not.toContain("sk-or-v1-abcdef0123456789abcdef");
  });

  it("spills a large output instead of flooding the context window", () => {
    process.env.REI_TOOL_OUTPUT_MAX_INLINE = "2000";
    const text = formatReceiptForModel(receipt({ output: "line\n".repeat(5000) }));
    expect(text.length).toBeLessThan(6000);
    expect(text).toMatch(/Full output saved to/);
  });
});
