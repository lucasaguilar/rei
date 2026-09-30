import { describe, it, expect } from "vitest";
import { validateMcpArgs } from "./mcp-args-validation.js";
import type { McpTool } from "../../tools/mcp/mcp-client.js";

// The shape of github/create_pull_request, trimmed: the tool the model called with `body: true`,
// which opened PR #21 with an empty description and cost thirteen turns to repair.
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

describe("validateMcpArgs", () => {
  it("rejects a boolean where the schema wants a string (the PR #21 case)", () => {
    const err = validateMcpArgs(CREATE_PR, { ...VALID, body: true });
    expect(err).toMatch(/body/);
    expect(err).toMatch(/string/);
  });

  it("names a missing required argument", () => {
    const { title: _omitted, ...noTitle } = VALID;
    expect(validateMcpArgs(CREATE_PR, noTitle)).toMatch(/title/);
  });

  it("tells the model how to recover, not just what failed", () => {
    expect(validateMcpArgs(CREATE_PR, { ...VALID, body: true })).toMatch(/call it again/i);
  });

  it("accepts arguments that match", () => {
    expect(validateMcpArgs(CREATE_PR, { ...VALID, body: "## Summary", draft: false })).toBeNull();
  });

  it("does not judge a tool that declares no schema", () => {
    expect(validateMcpArgs({ name: "x/y", description: "" }, { anything: 1 })).toBeNull();
  });

  it("does not judge a tool the registry does not know (the confirm gate handles that)", () => {
    expect(validateMcpArgs(undefined, { anything: 1 })).toBeNull();
  });

  // A server with a schema our validator cannot compile must still be usable: the server validates
  // its own input anyway, so this check is a fast path, never a new way for a tool to break.
  it("lets the call through when the schema itself cannot be compiled", () => {
    const broken: McpTool = {
      name: "x/broken",
      description: "",
      inputSchema: { type: "object", properties: { a: { $ref: "#/definitions/missing" } } },
    };
    expect(validateMcpArgs(broken, { a: 1 })).toBeNull();
  });
});
