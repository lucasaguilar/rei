import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("../../tools/search-tool.js", () => ({
  searchWeb: vi.fn(async () => "RESULT-BODY"),
}));
vi.mock("../../tools/weather-tool.js", () => ({
  getWeather: vi.fn(async () => ({ temp: 18 })),
  formatWeatherOutput: vi.fn(() => "18°C clear"),
}));
vi.mock("../../tools/command-executor.js", () => ({
  executeCommand: vi.fn(async () => ({ exitCode: 0, stdout: "hello", stderr: "" })),
  limitCommandOutput: vi.fn((s: string) => s),
}));
vi.mock("../../workspace/git-changes.js", () => ({
  detectGitChanges: vi.fn(async () => [
    { filePath: "src/file1.ts", status: "modified" },
    { filePath: "src/file2.ts", status: "added" },
  ]),
  getGitStatus: vi.fn(async () => ["src/file1.ts", "src/file2.ts"]),
}));

import { handleWebSearch, handleWeather, handleAskUser, handleRunCommand, handleGitChanges } from "./builtin-handlers.js";
import type { Elicitation } from "../../chat/elicitation.js";
import { searchWeb } from "../../tools/search-tool.js";
import { executeCommand } from "../../tools/command-executor.js";
import type { ModelProvider } from "../../providers/model-provider.js";

const fakeLogger = new Proxy({}, { get: () => vi.fn() }) as never;
const statusCtx = { logger: fakeLogger, emitStatus: () => {} };

afterEach(() => vi.clearAllMocks());

describe("builtin handlers", () => {
  it("handleWebSearch calls searchWeb and formats the result", async () => {
    const provider = {} as ModelProvider;
    const out = await handleWebSearch("weather BA", { ...statusCtx, provider });
    expect(searchWeb).toHaveBeenCalledWith("weather BA", provider);
    expect(out).toContain("RESULT-BODY");
    expect(out).toContain("Search Results: weather BA");
  });

  it("handleWeather formats the weather output", async () => {
    const out = await handleWeather("Buenos Aires", statusCtx);
    expect(out).toContain("18°C clear");
    expect(out).toContain("Weather: Buenos Aires");
  });

  it("handleAskUser builds a SELECT when options are given and returns the answer", async () => {
    let seen: Elicitation | undefined;
    const elicit = async (e: Elicitation) => {
      seen = e;
      return { id: e.id, value: "signup" };
    };
    const out = await handleAskUser("login or signup?", ["login", "signup"], {
      ...statusCtx,
      elicit,
    });
    expect(seen?.kind).toBe("select");
    expect(seen?.options?.map((o) => o.value)).toEqual(["login", "signup"]);
    expect(out).toBe("The user answered: signup");
  });

  it("handleAskUser builds a TEXT question when no options, and returns the free-form answer", async () => {
    let seen: Elicitation | undefined;
    const elicit = async (e: Elicitation) => {
      seen = e;
      return { id: e.id, value: "https://api.example.com" };
    };
    const out = await handleAskUser("api base url?", undefined, { ...statusCtx, elicit });
    expect(seen?.kind).toBe("text");
    expect(out).toContain("https://api.example.com");
  });

  it("handleAskUser tells the model to assume when the user does not answer (headless default)", async () => {
    const elicit = async (e: Elicitation) => ({ id: e.id, value: "" });
    const out = await handleAskUser("which one?", undefined, { ...statusCtx, elicit });
    expect(out).toContain("did not answer");
    expect(out).toContain("best assumption");
  });

  it("handleAskUser rejects an empty question", async () => {
    const elicit = async (e: Elicitation) => ({ id: e.id, value: "x" });
    const out = await handleAskUser("  ", undefined, { ...statusCtx, elicit });
    expect(out).toContain("ERROR");
  });

  it("handleRunCommand executes and reports exit code + stdout", async () => {
    const out = await handleRunCommand("npm test", { ...statusCtx, workspacePath: "/ws" });
    expect(executeCommand).toHaveBeenCalledWith("npm test", "/ws");
    expect(out).toContain("Exit: 0");
    expect(out).toContain("hello");
  });

  it("handleGitChanges detects and formats git changes", async () => {
    const out = await handleGitChanges({ ...statusCtx, workspacePath: "/ws" });
    expect(out).toContain("Uncommitted Changes Detected");
    expect(out).toContain("[M] src/file1.ts");
    expect(out).toContain("[A] src/file2.ts");
  });
});
