import { describe, it, expect, afterEach } from "vitest";
import { resolveWorkerModel } from "./sub-agent-runner.js";
import { resolveModelForMode } from "../providers/provider-factory.js";

afterEach(() => {
  delete process.env.REI_SUBAGENT_MODEL;
});

describe("resolveWorkerModel (Phase 2 worker model swap)", () => {
  it("prefers the explicit argument over everything", () => {
    process.env.REI_SUBAGENT_MODEL = "mlx-community/ornith-1.0-35b";
    expect(resolveWorkerModel("qwen/qwen3.6-35b-a3b")).toBe("qwen/qwen3.6-35b-a3b");
  });

  it("uses REI_SUBAGENT_MODEL when no explicit arg (the delegated fast executor)", () => {
    process.env.REI_SUBAGENT_MODEL = "mlx-community/ornith-1.0-35b";
    expect(resolveWorkerModel()).toBe("mlx-community/ornith-1.0-35b");
  });

  it("falls back to the same agent model when neither is set (Phase 1 behavior preserved)", () => {
    delete process.env.REI_SUBAGENT_MODEL;
    expect(resolveWorkerModel()).toBe(resolveModelForMode("agent"));
  });
});
