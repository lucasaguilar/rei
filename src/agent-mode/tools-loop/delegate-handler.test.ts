import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("../sub-agent-runner.js", () => ({
  runSubAgent: vi.fn(async () => "edited src/a.ts; added the function"),
}));

import { handleDelegate } from "./delegate-handler.js";
import { runSubAgent } from "../sub-agent-runner.js";

const fakeLogger = new Proxy({}, { get: () => vi.fn() }) as never;
const ctx = {
  provider: {} as never,
  workspacePath: "/w",
  logger: fakeLogger,
  emitStatus: () => {},
};

afterEach(() => vi.clearAllMocks());

describe("handleDelegate", () => {
  it("rejects an empty task without running a sub-agent", async () => {
    const out = await handleDelegate({ task: "   " }, ctx);
    expect(out).toContain("ERROR");
    expect(runSubAgent).not.toHaveBeenCalled();
  });

  it("runs the sub-agent, filters non-string files, and returns its summary", async () => {
    const out = await handleDelegate(
      { task: "add validateEmail", files: ["src/a.ts", 3, "", "src/b.ts"] },
      ctx,
    );
    expect(runSubAgent).toHaveBeenCalledTimes(1);
    const arg = (runSubAgent as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0] as {
      task: string;
      files?: string[];
    };
    expect(arg.task).toBe("add validateEmail");
    expect(arg.files).toEqual(["src/a.ts", "src/b.ts"]);
    expect(out).toContain("edited src/a.ts");
  });
});
