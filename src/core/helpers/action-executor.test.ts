import { describe, it, expect, vi, beforeEach } from "vitest";

// Stub the external fire-and-forget tools so no network is touched.
vi.mock("../../tools/weather-tool.js", () => ({
  getWeather: vi.fn().mockResolvedValue({ location: "London" }),
  formatWeatherOutput: vi.fn().mockReturnValue("WEATHER_OUTPUT"),
}));
vi.mock("../../tools/search-tool.js", () => ({
  searchWeb: vi.fn().mockResolvedValue("SEARCH_OUTPUT"),
}));
vi.mock("../../tools/git-changes-tool.js", () => ({
  getGitChanges: vi.fn().mockResolvedValue("MOCKED_GIT_CHANGES"),
}));

// Control the skill catalog without touching disk; keep the real skillsForMode /
// findSkill so the mode-scoping and lookup logic is exercised for real.
vi.mock("../../skills/skill-loader.js", async (importActual) => {
  const actual =
    await importActual<typeof import("../../skills/skill-loader.js")>();
  return {
    ...actual,
    loadSkills: vi.fn(() => [
      {
        name: "micro-task-decomposition",
        description: "break stages into micro tasks",
        modes: ["planning"],
        body: "RECIPE_BODY_MICRO",
      },
      {
        name: "write-tests",
        description: "write tests",
        modes: ["agent"],
        body: "RECIPE_BODY_TESTS",
      },
    ]),
  };
});

import { executeAgentToolsAndCommands } from "./action-executor.js";

const fakeLogger = {
  logInfo: vi.fn(),
  logCommandExecution: vi.fn(),
} as never;

const fakeProvider = {} as never;

function makeRegistry(dispatch = vi.fn().mockResolvedValue("MCP_RESULT")) {
  return { dispatch } as never;
}

describe("executeAgentToolsAndCommands", () => {
  beforeEach(() => vi.clearAllMocks());

  it("routes mcp: calls through the same dispatcher", async () => {
    const dispatch = vi.fn().mockResolvedValue("MCP_RESULT");
    const response = `<call_tool name="mcp:db/query">{"sql":"SELECT 1"}</call_tool>`;

    const feedback = await executeAgentToolsAndCommands(
      response,
      "/workspace",
      fakeProvider,
      fakeLogger,
      makeRegistry(dispatch),
    );

    expect(dispatch).toHaveBeenCalledWith("db/query", { sql: "SELECT 1" });
    expect(feedback).toContain("🔌 MCP: db/query");
    expect(feedback).toContain("MCP_RESULT");
  });
});
