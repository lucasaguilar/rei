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

import {
  executeToolCallsFromResponse,
  executeAgentToolsAndCommands,
} from "./action-executor.js";

const fakeLogger = {
  logInfo: vi.fn(),
  logCommandExecution: vi.fn(),
} as never;

const fakeProvider = {} as never;

function makeRegistry(dispatch = vi.fn().mockResolvedValue("MCP_RESULT")) {
  return { dispatch } as never;
}

describe("dispatchXmlToolCall (via executeToolCallsFromResponse)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("routes an mcp: call to the registry with the 'mcp:' prefix stripped", async () => {
    const dispatch = vi.fn().mockResolvedValue("file contents");
    const response = `<call_tool name="mcp:fs/readFile">{"path":"a.ts"}</call_tool>`;

    const feedback = await executeToolCallsFromResponse(
      response,
      fakeProvider,
      fakeLogger,
      makeRegistry(dispatch),
    );

    expect(dispatch).toHaveBeenCalledWith("fs/readFile", { path: "a.ts" });
    expect(feedback).toContain("🔌 MCP: fs/readFile");
    expect(feedback).toContain("file contents");
  });

  it("reports an error (without throwing) for an unknown non-MCP tool", async () => {
    const response = `<call_tool name="bogus">{"x":1}</call_tool>`;

    const feedback = await executeToolCallsFromResponse(
      response,
      fakeProvider,
      fakeLogger,
      makeRegistry(),
    );

    expect(feedback).toContain("ERROR");
    expect(feedback).toContain("is not implemented");
  });

  it("still dispatches the built-in weather tool (regression)", async () => {
    const response = `<call_tool name="weather">London</call_tool>`;

    const feedback = await executeToolCallsFromResponse(
      response,
      fakeProvider,
      fakeLogger,
      makeRegistry(),
    );

    expect(feedback).toContain("🌤️ Weather: London");
    expect(feedback).toContain("WEATHER_OUTPUT");
  });

  it("surfaces an MCP dispatch failure as an error chunk", async () => {
    const dispatch = vi.fn().mockRejectedValue(new Error("server exploded"));
    const response = `<call_tool name="mcp:fs/readFile">{"path":"a.ts"}</call_tool>`;

    const feedback = await executeToolCallsFromResponse(
      response,
      fakeProvider,
      fakeLogger,
      makeRegistry(dispatch),
    );

    expect(feedback).toContain("ERROR: server exploded");
  });

  it("dispatches git_changes tool call and formats it", async () => {
    const response = `<call_tool name="git_changes">{}</call_tool>`;

    const feedback = await executeToolCallsFromResponse(
      response,
      fakeProvider,
      fakeLogger,
      makeRegistry(),
      { workspacePath: "/workspace", mode: "planning" },
    );

    expect(feedback).toContain("📁 Git Changes:");
    expect(feedback).toContain("MOCKED_GIT_CHANGES");
  });
});

describe("use_skill dispatch (regression)", () => {
  beforeEach(() => vi.clearAllMocks());

  const skillCtx = (mode: "planning" | "agent") => ({
    workspacePath: "/workspace",
    mode,
  });

  it("loads the skill body from the XML tag's inner text (args.input)", async () => {
    // <call_tool name="use_skill">NAME</call_tool> parses the inner text into
    // args.input — reading args.name/args.skill instead silently broke this.
    const response = `<call_tool name="use_skill">micro-task-decomposition</call_tool>`;

    const feedback = await executeToolCallsFromResponse(
      response,
      fakeProvider,
      fakeLogger,
      makeRegistry(),
      skillCtx("planning"),
    );

    expect(feedback).toContain("🧩 Skill: micro-task-decomposition");
    expect(feedback).toContain("RECIPE_BODY_MICRO");
    expect(feedback).not.toContain("ERROR");
  });

  it("scopes skills by mode: a planning-only skill is not loadable from agent mode", async () => {
    const response = `<call_tool name="use_skill">micro-task-decomposition</call_tool>`;

    const feedback = await executeToolCallsFromResponse(
      response,
      fakeProvider,
      fakeLogger,
      makeRegistry(),
      skillCtx("agent"),
    );

    expect(feedback).toContain("ERROR");
    expect(feedback).toContain("no such skill for agent mode");
    expect(feedback).not.toContain("RECIPE_BODY_MICRO");
  });

  it("tolerantly loads a skill called by its own name (not via use_skill)", async () => {
    // Models often emit <call_tool name="write-spec"> instead of
    // <call_tool name="use_skill">write-spec</call_tool> — load it anyway.
    const response = `<call_tool name="micro-task-decomposition">{"title":"x"}</call_tool>`;

    const feedback = await executeToolCallsFromResponse(
      response,
      fakeProvider,
      fakeLogger,
      makeRegistry(),
      skillCtx("planning"),
    );

    expect(feedback).toContain("🧩 Skill: micro-task-decomposition");
    expect(feedback).toContain("RECIPE_BODY_MICRO");
    expect(feedback).not.toContain("not implemented");
  });

  it("does not treat an unknown tool name as a skill", async () => {
    const response = `<call_tool name="bogus-tool">{}</call_tool>`;

    const feedback = await executeToolCallsFromResponse(
      response,
      fakeProvider,
      fakeLogger,
      makeRegistry(),
      skillCtx("planning"),
    );

    expect(feedback).toContain("is not implemented");
  });

  it("returns an error (not a wrong-skill match) when no skill name is given", async () => {
    const response = `<call_tool name="use_skill"></call_tool>`;

    const feedback = await executeToolCallsFromResponse(
      response,
      fakeProvider,
      fakeLogger,
      makeRegistry(),
      skillCtx("planning"),
    );

    expect(feedback).toContain("ERROR");
    expect(feedback).not.toContain("RECIPE_BODY_MICRO");
  });

  it("reports skills unavailable when no skill context is provided", async () => {
    const response = `<call_tool name="use_skill">micro-task-decomposition</call_tool>`;

    const feedback = await executeToolCallsFromResponse(
      response,
      fakeProvider,
      fakeLogger,
      makeRegistry(),
      // no skillContext
    );

    expect(feedback).toContain("not available in this context");
  });
});

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
