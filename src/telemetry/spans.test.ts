import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  startStepSpan,
  withStepSpan,
  withToolSpan,
  withTurnSpan,
  withTurnSpanStream,
} from "./spans.js";
import { initTelemetry } from "./init.js";

describe("telemetry span helpers", () => {
  it("withTurnSpan runs the wrapped fn and returns its value", async () => {
    await expect(withTurnSpan("hello", async () => 42)).resolves.toBe(42);
  });

  it("withTurnSpanStream passes the generator's chunks through unchanged", async () => {
    async function* gen(): AsyncIterable<string> {
      yield "a";
      yield "b";
      yield "c";
    }
    const out: string[] = [];
    for await (const chunk of withTurnSpanStream("prompt", () => gen())) {
      out.push(chunk);
    }
    expect(out).toEqual(["a", "b", "c"]);
  });

  it("withStepSpan runs the wrapped fn and returns its value", async () => {
    await expect(withStepSpan(3, async () => "step-result")).resolves.toBe(
      "step-result",
    );
  });

  it("startStepSpan returns an end thunk that closes the span without throwing", () => {
    const endStep = startStepSpan(2);
    expect(typeof endStep).toBe("function");
    expect(() => endStep()).not.toThrow();
  });

  it("withToolSpan runs the wrapped fn and returns its value", async () => {
    await expect(
      withToolSpan("delegate_to_agent", { target: "auditor" }, async () => ({
        ok: true,
      })),
    ).resolves.toEqual({ ok: true });
  });

  it("withToolSpan nests under an active Turn/Step without throwing", async () => {
    const result = await withTurnSpan("prompt", async () => {
      const endStep = startStepSpan(0);
      try {
        return await withToolSpan("run_command", { command: "ls" }, async () =>
          "ok",
        );
      } finally {
        endStep();
      }
    });
    expect(result).toBe("ok");
  });
});

describe("initTelemetry", () => {
  const originalApiKey = process.env.LMNR_PROJECT_API_KEY;
  const originalTelemetryDisabled = process.env.REI_TELEMETRY_DISABLED;

  beforeEach(() => {
    delete process.env.LMNR_PROJECT_API_KEY;
    delete process.env.REI_TELEMETRY_DISABLED;
  });

  afterEach(() => {
    if (originalApiKey === undefined) delete process.env.LMNR_PROJECT_API_KEY;
    else process.env.LMNR_PROJECT_API_KEY = originalApiKey;
    if (originalTelemetryDisabled === undefined)
      delete process.env.REI_TELEMETRY_DISABLED;
    else process.env.REI_TELEMETRY_DISABLED = originalTelemetryDisabled;
  });

  it("without an API key: warns once, no-ops, and does not throw", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(() => initTelemetry()).not.toThrow();
    expect(() => initTelemetry()).not.toThrow(); // idempotent second call

    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
