import { describe, it, expect, vi } from "vitest";

// Control searchMcpTools so the activate/empty branches are deterministic (the real one is a
// ranked search that returns top-K even for a poor query).
vi.mock("../../tools/tool-retriever.js", () => ({
  SEARCH_K: 5,
  searchMcpTools: vi.fn((q: string, tools: Array<{ name: string }>) =>
    tools.filter((t) => t.name.includes(q)),
  ),
}));

import { handleSearchTools, handleUseSkill } from "./meta-handlers.js";
import type { Skill } from "../../skills/skill-loader.js";

const fakeLogger = new Proxy({}, { get: () => vi.fn() }) as never;
const statusCtx = { logger: fakeLogger, emitStatus: () => {} };

describe("handleSearchTools", () => {
  const allMcpTools = [
    { name: "gmail_send", description: "send email" },
    { name: "calendar_add", description: "add event" },
  ] as never[];

  it("activates matching tools (mutates activeMcp) and lists them", () => {
    const activeMcp = new Set<string>();
    const out = handleSearchTools("gmail", { ...statusCtx, allMcpTools, activeMcp });
    expect(activeMcp.has("gmail_send")).toBe(true);
    expect(out).toContain("gmail_send");
  });

  it("reports when nothing matched", () => {
    const out = handleSearchTools("zzzzz", {
      ...statusCtx,
      allMcpTools,
      activeMcp: new Set(),
    });
    expect(out).toContain("No tools matched");
  });
});

describe("handleUseSkill", () => {
  const skills: Skill[] = [
    { name: "deploy", description: "deploy steps", body: "1. build 2. push" } as Skill,
  ];

  it("loads a known skill's body", () => {
    const out = handleUseSkill("deploy", { ...statusCtx, skills });
    expect(out).toContain("1. build 2. push");
  });

  it("lists available skills when the name is unknown", () => {
    const out = handleUseSkill("nope", { ...statusCtx, skills });
    expect(out).toContain("No skill named");
    expect(out).toContain("deploy");
  });
});
