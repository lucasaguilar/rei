import { describe, it, expect } from "vitest";
import { correctedMcpArgs, checkMcpCall } from "./mcp-invalid-retry.js";
import type { McpTool } from "../../tools/mcp/mcp-client.js";

const CREATE_PR: McpTool = {
  name: "github/create_pull_request",
  description: "Create a pull request",
  inputSchema: {
    type: "object",
    properties: {
      owner: { type: "string" },
      repo: { type: "string" },
      title: { type: "string" },
      body: { type: "string" },
      head: { type: "string" },
      base: { type: "string" },
      draft: { type: "boolean" },
    },
    required: ["owner", "repo", "title", "head", "base"],
  },
};

const VALID = { owner: "lucasaguilar", repo: "rei", title: "t", head: "feat/x", base: "main" };

describe("correctedMcpArgs — something right to copy", () => {
  it("renames a key to the one it was mistaken for, keeping the value", () => {
    expect(correctedMcpArgs(CREATE_PR, { ...VALID, "body ": "## Summary" })).toEqual({
      ...VALID,
      body: "## Summary",
    });
  });

  it("drops a key it cannot map to anything", () => {
    expect(correctedMcpArgs(CREATE_PR, { ...VALID, reviewers: ["a"] })).toEqual(VALID);
  });

  it("marks a wrong-typed value as a placeholder instead of repeating it", () => {
    expect(correctedMcpArgs(CREATE_PR, { ...VALID, body: true })).toEqual({ ...VALID, body: "<string>" });
  });

  it("adds a missing required argument as a placeholder", () => {
    const { title: _omitted, ...noTitle } = VALID;
    expect(correctedMcpArgs(CREATE_PR, noTitle)).toMatchObject({ title: "<string>" });
  });

  it("does not let a renamed key overwrite one the model already set correctly", () => {
    expect(correctedMcpArgs(CREATE_PR, { ...VALID, body: "real", "body ": "dup" })).toEqual({
      ...VALID,
      body: "real",
    });
  });
});

// Seen live: 8 rejections of list_pull_requests (`heads`, `state_filter`) and 11 of
// create_pull_request (`bodyType`) — the reasoning said "the key is body" and the call said
// `bodyType` again, because the model copied its own previous call from the history.
describe("checkMcpCall — escalating the same mistake", () => {
  const bad = { ...VALID, "body ": "x" };

  it("passes valid arguments", () => {
    expect(checkMcpCall(CREATE_PR, VALID, new Map())).toBeNull();
  });

  it("first rejection: the problem and a corrected call to copy", () => {
    const r = checkMcpCall(CREATE_PR, bad, new Map())!;
    expect(r.message).toContain('did you mean "body"');
    expect(r.message).toContain('"body": "x"');
    expect(r.repeatBlocked).toBe(false);
  });

  it("second identical rejection: says it is the same mistake and not to copy the old call", () => {
    const history = new Map<string, number>();
    checkMcpCall(CREATE_PR, bad, history);
    const r = checkMcpCall(CREATE_PR, bad, history)!;
    expect(r.message).toMatch(/SAME invalid arguments/);
    expect(r.message).toMatch(/do NOT copy/i);
    expect(r.message).toContain('"body": "x"');
    expect(r.repeatBlocked).toBe(false);
  });

  // Seen live: the third rejection of an OPTIONAL pre-check (list_pull_requests, "does a PR already
  // exist?") said "in your final answer…" and counted as a blocked repeat, so the loop added
  // "Do NOT call any tool" — the model gave up the whole task and never created the PR.
  it("third identical rejection: drops this call but lets the task go on", () => {
    const history = new Map<string, number>();
    checkMcpCall(CREATE_PR, bad, history);
    checkMcpCall(CREATE_PR, bad, history);
    const r = checkMcpCall(CREATE_PR, bad, history)!;
    expect(r.message).toMatch(/Stop calling github\/create_pull_request/);
    expect(r.message).toMatch(/continue the task without it/i);
    expect(r.message).not.toMatch(/final answer/i);
    expect(r.repeatBlocked).toBe(false);
  });

  it("calling it again after being told to stop counts as a blocked repeat", () => {
    const history = new Map<string, number>();
    for (let i = 0; i < 3; i++) checkMcpCall(CREATE_PR, bad, history);
    expect(checkMcpCall(CREATE_PR, bad, history)!.repeatBlocked).toBe(true);
  });

  // The model varied the body text between retries while keeping `bodyType`: identity is the
  // mistake, not the exact arguments.
  it("counts the same mistake as a repeat even when other values changed", () => {
    const history = new Map<string, number>();
    checkMcpCall(CREATE_PR, { ...VALID, "body ": "first draft" }, history);
    const r = checkMcpCall(CREATE_PR, { ...VALID, "body ": "second draft" }, history)!;
    expect(r.message).toMatch(/SAME invalid arguments/);
  });

  it("treats a different mistake as a fresh first attempt", () => {
    const history = new Map<string, number>();
    checkMcpCall(CREATE_PR, bad, history);
    const r = checkMcpCall(CREATE_PR, { ...VALID, body: true }, history)!;
    expect(r.message).not.toMatch(/SAME invalid arguments/);
  });
});
